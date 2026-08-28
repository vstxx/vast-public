param(
  [string] $PreviousBaseUrl = $env:VAST_PREVIOUS_RELEASE_BASE_URL,
  [string] $CurrentBaseUrl = $env:VAST_PRODUCTION_RELEASE_BASE_URL,
  [string] $CurrentReleaseRoot = $env:VAST_CURRENT_RELEASE_ROOT,
  [string] $PreviousVersion = $env:VAST_PREVIOUS_VERSION,
  [string] $CurrentVersion = $env:VAST_RELEASE_VERSION,
  [string] $ExpectedSignerSubject = $env:VAST_EXPECTED_SIGNER_SUBJECT
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PreviousBaseUrl)) { throw 'The previous production release base URL is required.' }
if ([string]::IsNullOrWhiteSpace($CurrentBaseUrl) -and [string]::IsNullOrWhiteSpace($CurrentReleaseRoot)) { throw 'CurrentBaseUrl or CurrentReleaseRoot is required.' }
if ([string]::IsNullOrWhiteSpace($PreviousVersion) -or [string]::IsNullOrWhiteSpace($CurrentVersion)) { throw 'Both beta upgrade versions are required.' }
if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) { throw 'Expected signer subject is required.' }

function Assert-True([bool] $Condition, [string] $Message) { if (-not $Condition) { throw "Assertion failed: $Message" } }
function Assert-Equal([object] $Expected, [object] $Actual, [string] $Message) { if ($Expected -ne $Actual) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." } }
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
function Assert-Signed([string] $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
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
  Assert-Equal ((Get-FileHash -LiteralPath $previousZip -Algorithm SHA256).Hash.ToLowerInvariant()) ([string] $previousManifest.package.sha256).ToLowerInvariant() 'previous package hash must match'

  $previousExpanded = Join-Path $testRoot 'previous-expanded'
  Expand-Archive -LiteralPath $previousZip -DestinationPath $previousExpanded -Force
  $installPath = Join-Path $previousExpanded ([string] $previousManifest.package.payloadPath)
  Assert-Signed (Join-Path $installPath 'Vast.exe')
  Assert-Signed $currentUpdater

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
  foreach ($entry in $sentinels.GetEnumerator()) { $before[$entry.Key] = (Get-FileHash -LiteralPath (Join-Path $userData $entry.Key) -Algorithm SHA256).Hash }

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
    throw "Assertion failed: signed public updater must complete successfully. Exit code $($process.ExitCode).`n$diagnostic"
  }
  Assert-Signed (Join-Path $installPath 'Vast.exe')
  $installedVersion = (Get-Content -Raw -LiteralPath (Join-Path $installPath 'version.json') | ConvertFrom-Json).version
  Assert-Equal $CurrentVersion $installedVersion 'runtime must advance to the next signed beta/release'
  foreach ($entry in $sentinels.GetEnumerator()) {
    Assert-Equal $before[$entry.Key] (Get-FileHash -LiteralPath (Join-Path $userData $entry.Key) -Algorithm SHA256).Hash "$($entry.Key) must be preserved byte-for-byte"
  }
  $relay = Get-Content -Raw -LiteralPath (Join-Path $userData 'vast-relay-state.json') | ConvertFrom-Json
  Assert-Equal $installId $relay.install_id 'Relay install ID must survive the upgrade'
  Assert-Equal 17 $relay.launch_count 'updater must not mutate the Relay launch count'
  Write-Host "Verified signed $PreviousVersion -> $CurrentVersion upgrade with user data preservation."
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
