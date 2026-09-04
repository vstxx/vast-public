param(
  [string] $PreviousBaseUrl = $env:VAST_PREVIOUS_RELEASE_BASE_URL,
  [string] $CurrentBaseUrl = $env:VAST_PRODUCTION_RELEASE_BASE_URL,
  [string] $CurrentReleaseRoot = $env:VAST_CURRENT_RELEASE_ROOT,
  [string] $PreviousVersion = $env:VAST_PREVIOUS_VERSION,
  [string] $CurrentVersion = $env:VAST_RELEASE_VERSION,
  [string] $ExpectedSignerSubject = $env:VAST_EXPECTED_SIGNER_SUBJECT,
  [string] $PreviousSignaturePolicy = $(if ($env:VAST_PREVIOUS_SIGNATURE_POLICY) { $env:VAST_PREVIOUS_SIGNATURE_POLICY } else { 'signed' }),
  [string] $CurrentSignaturePolicy = $(if ($env:VAST_CURRENT_SIGNATURE_POLICY) { $env:VAST_CURRENT_SIGNATURE_POLICY } else { 'signed' })
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PreviousBaseUrl)) { throw 'The previous production release base URL is required.' }
if ([string]::IsNullOrWhiteSpace($CurrentBaseUrl) -and [string]::IsNullOrWhiteSpace($CurrentReleaseRoot)) { throw 'CurrentBaseUrl or CurrentReleaseRoot is required.' }
if ([string]::IsNullOrWhiteSpace($PreviousVersion) -or [string]::IsNullOrWhiteSpace($CurrentVersion)) { throw 'Both beta upgrade versions are required.' }
if (($PreviousSignaturePolicy -eq 'signed' -or $CurrentSignaturePolicy -eq 'signed') -and [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) { throw 'Expected signer subject is required for signed upgrade artifacts.' }

# GitHub Actions runs release steps in PowerShell 7, then invokes this script
# with Windows PowerShell for Authenticode. PSModulePath can still point at the
# PowerShell 7 module tree, which makes Windows PowerShell find an incompatible
# Microsoft.PowerShell.Security module. Import the module shipped with the
# current host explicitly so the public upgrade gate never depends on inherited
# shell state.
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $securityModule -PathType Leaf)) {
  throw "The Authenticode security module is unavailable for this PowerShell host: $securityModule"
}
Import-Module -Name $securityModule -Force -ErrorAction Stop
if (-not (Get-Command -Name Get-AuthenticodeSignature -CommandType Cmdlet -ErrorAction SilentlyContinue)) {
  throw 'Get-AuthenticodeSignature is unavailable after loading Microsoft.PowerShell.Security.'
}

function Assert-True([bool] $Condition, [string] $Message) { if (-not $Condition) { throw "Assertion failed: $Message" } }
function Assert-Equal([object] $Expected, [object] $Actual, [string] $Message) { if ($Expected -ne $Actual) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." } }
function Get-Sha256([string] $Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}
function Get-ProductionFile([string] $Url, [string] $Path) {
  $curl = Get-Command 'curl.exe' -ErrorAction Stop
  $download = Start-Process -FilePath $curl.Source -ArgumentList @(
    '--fail',
    '--location',
    '--retry', '3',
    '--retry-all-errors',
    '--connect-timeout', '30',
    '--max-time', '1200',
    '--output', "`"$Path`"",
    $Url
  ) -Wait -PassThru -NoNewWindow
  Assert-Equal 0 $download.ExitCode "download must succeed: $Url"
}
function Assert-Signature([string] $Path, [string] $Policy) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Policy -eq 'unsigned') {
    Assert-Equal 'NotSigned' ([string] $signature.Status) "$Path must remain an authentic unsigned historical artifact"
    return
  }
  if ($Policy -ne 'signed') { throw "Unknown signature policy: $Policy" }
  Assert-Equal 'Valid' ([string] $signature.Status) "$Path must have a valid Authenticode signature"
  Assert-True (-not [string]::IsNullOrWhiteSpace([string] $signature.TimeStamperCertificate.Subject)) "$Path must be timestamped"
  Assert-True ([string] $signature.SignerCertificate.Subject -like "*$ExpectedSignerSubject*") "$Path must be signed by $ExpectedSignerSubject"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vpb-{0}" -f [Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
  $previousManifestPath = Join-Path $testRoot 'previous-update-manifest.json'
  $previousZip = Join-Path $testRoot "Vast-$PreviousVersion-update.zip"
  $currentUpdater = Join-Path $testRoot "VastUpdater-$CurrentVersion.exe"
  $currentManifestLocation = "$($CurrentBaseUrl.TrimEnd('/'))/update-manifest.json"
  Get-ProductionFile "$($PreviousBaseUrl.TrimEnd('/'))/update-manifest.json" $previousManifestPath
  Get-ProductionFile "$($PreviousBaseUrl.TrimEnd('/'))/Vast-$PreviousVersion-update.zip" $previousZip
  if (-not [string]::IsNullOrWhiteSpace($CurrentReleaseRoot)) {
    $resolvedCurrent = (Resolve-Path -LiteralPath $CurrentReleaseRoot).Path
    Copy-Item -LiteralPath (Join-Path $resolvedCurrent "Updater\VastUpdater-$CurrentVersion.exe") -Destination $currentUpdater -Force
    $currentManifestLocation = Join-Path $resolvedCurrent 'Downloads\update-manifest.json'
  } else {
    Get-ProductionFile "$($CurrentBaseUrl.TrimEnd('/'))/VastUpdater-$CurrentVersion.exe" $currentUpdater
  }
  $previousManifest = Get-Content -Raw -LiteralPath $previousManifestPath | ConvertFrom-Json
  Assert-Equal $PreviousVersion $previousManifest.version 'previous manifest version must match'
  Assert-Equal (Get-Sha256 $previousZip) ([string] $previousManifest.package.sha256).ToLowerInvariant() 'previous package hash must match'

  $previousExpanded = Join-Path $testRoot 'previous-expanded'
  Expand-Archive -LiteralPath $previousZip -DestinationPath $previousExpanded -Force
  $installPath = Join-Path $previousExpanded ([string] $previousManifest.package.payloadPath)
  Assert-Signature (Join-Path $installPath 'Vast.exe') $PreviousSignaturePolicy
  Assert-Signature $currentUpdater $CurrentSignaturePolicy

  $userData = Join-Path $testRoot 'user-data'
  New-Item -ItemType Directory -Path (Join-Path $userData 'Network'), (Join-Path $userData 'Partitions\vast-default\Network') -Force | Out-Null
  $installId = [Guid]::NewGuid().ToString()
  $sentinels = @{
    'vast-data.json' = '{"schemaVersion":8,"bookmarks":[{"title":"preserve-beta"}],"tabs":[{"url":"https://example.test"}]}'
    'password-vault.json' = '{"schemaVersion":1,"records":[{"id":"preserve-vault"}]}'
    'vast-relay-state.json' = "{`"schema_version`":1,`"install_id`":`"$installId`",`"launch_count`":17,`"dismissed`":[]}"
    'Local State' = '{"os_crypt":{"encrypted_key":"preserve-key"}}'
    'Network\Cookies' = 'preserve-default-cookie'
    'Partitions\vast-default\Network\Cookies' = 'preserve-partition-cookie'
  }
  foreach ($entry in $sentinels.GetEnumerator()) {
    $target = Join-Path $userData $entry.Key
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Set-Content -LiteralPath $target -Value $entry.Value -NoNewline -Encoding UTF8
  }
  $before = @{}
  foreach ($entry in $sentinels.GetEnumerator()) { $before[$entry.Key] = Get-Sha256 (Join-Path $userData $entry.Key) }

  $downloadDir = Join-Path $testRoot 'current-download'
  $bootstrapLog = Join-Path $testRoot 'bootstrapper.log'
  $updaterArguments = @(
    '--manifest-url', "`"$currentManifestLocation`"",
    '--install-path', "`"$installPath`"",
    '--user-data-root', "`"$userData`"",
    '--download-dir', "`"$downloadDir`"",
    '--bootstrap-log-path', "`"$bootstrapLog`"",
    '--non-interactive'
  )
  $process = Start-Process -FilePath $currentUpdater -ArgumentList $updaterArguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    $diagnostic = if (Test-Path -LiteralPath $bootstrapLog -PathType Leaf) { (Get-Content -Raw -LiteralPath $bootstrapLog).Trim() } else { 'bootstrapper log was not created' }
    throw "Assertion failed: public candidate updater must complete successfully. Exit code $($process.ExitCode).`n$diagnostic"
  }
  Assert-Signature (Join-Path $installPath 'Vast.exe') $CurrentSignaturePolicy
  $installedVersion = (Get-Content -Raw -LiteralPath (Join-Path $installPath 'version.json') | ConvertFrom-Json).version
  Assert-Equal $CurrentVersion $installedVersion 'runtime must advance to the current public candidate'
  foreach ($entry in $sentinels.GetEnumerator()) {
    Assert-Equal $before[$entry.Key] (Get-Sha256 (Join-Path $userData $entry.Key)) "$($entry.Key) must be preserved byte-for-byte"
  }
  $relay = Get-Content -Raw -LiteralPath (Join-Path $userData 'vast-relay-state.json') | ConvertFrom-Json
  Assert-Equal $installId $relay.install_id 'Relay install ID must survive the upgrade'
  Assert-Equal 17 $relay.launch_count 'updater must not mutate the Relay launch count'
  Write-Host "Verified public $PreviousVersion -> $CurrentVersion upgrade with user data preservation."
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
