param(
  [string] $CurrentReleaseRoot = $env:VAST_CURRENT_RELEASE_ROOT,
  [string] $CurrentVersion = $env:VAST_RELEASE_VERSION,
  [string] $PreviousInstallerUrl = 'https://github.com/vstxx/vast-public/releases/download/public-release-0.1.5/Vast-Setup-0.1.5.exe'
)

$ErrorActionPreference = 'Stop'
$PreviousVersion = '0.1.5'
$ExpectedPreviousSha256 = 'a82c0a9cfea5564894db3b9bb3eedf9ce976d811bcfeb7c8680c9f6f6408b06a'
if ([string]::IsNullOrWhiteSpace($CurrentReleaseRoot)) { throw 'VAST_CURRENT_RELEASE_ROOT is required.' }
if ([string]::IsNullOrWhiteSpace($CurrentVersion)) { throw 'VAST_RELEASE_VERSION is required.' }
if ($CurrentVersion -ne '0.2.5') { throw "This release-candidate harness requires target version 0.2.5, got $CurrentVersion." }

function Assert-True([bool] $Condition, [string] $Message) { if (-not $Condition) { throw "Assertion failed: $Message" } }
function Assert-Equal([object] $Expected, [object] $Actual, [string] $Message) { if ($Expected -ne $Actual) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." } }

$releaseRoot = (Resolve-Path -LiteralPath $CurrentReleaseRoot).Path
$currentUpdater = Join-Path $releaseRoot "Updater\VastUpdater-$CurrentVersion.exe"
$currentManifest = Join-Path $releaseRoot 'Downloads\update-manifest.json'
Assert-True (Test-Path -LiteralPath $currentUpdater -PathType Leaf) 'local 0.2.5 updater must exist'
Assert-True (Test-Path -LiteralPath $currentManifest -PathType Leaf) 'local 0.2.5 update manifest must exist'

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vup-{0}" -f [Guid]::NewGuid().ToString('N').Substring(0, 12))
$installPath = Join-Path $testRoot 'installed-vast'
$userData = Join-Path $testRoot 'profile'
$installer = Join-Path $testRoot 'Vast-Setup-0.1.5.exe'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
  $curl = Get-Command 'curl.exe' -ErrorAction Stop
  $download = Start-Process -FilePath $curl.Source -ArgumentList @(
    '--fail',
    '--location',
    '--retry', '3',
    '--retry-all-errors',
    '--connect-timeout', '30',
    '--max-time', '1200',
    '--output', $installer,
    $PreviousInstallerUrl
  ) -Wait -PassThru -NoNewWindow
  Assert-Equal 0 $download.ExitCode 'public 0.1.5 installer download must succeed'
  Assert-Equal $ExpectedPreviousSha256 ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()) 'public 0.1.5 installer SHA-256 must match the immutable published asset'
  Assert-Equal 'NotSigned' ([string](Get-AuthenticodeSignature -LiteralPath $installer).Status) 'the real public 0.1.5 installer is intentionally unsigned'

  $install = Start-Process -FilePath $installer -ArgumentList @('/currentuser', '/S', "/D=$installPath") -Wait -PassThru -WindowStyle Hidden
  Assert-Equal 0 $install.ExitCode '0.1.5 isolated installation must succeed'
  Assert-True (Test-Path -LiteralPath (Join-Path $installPath 'Vast.exe') -PathType Leaf) '0.1.5 runtime must be installed in the isolated target'

  New-Item -ItemType Directory -Path (Join-Path $userData 'Network'), (Join-Path $userData 'Partitions\vast-default\Network') -Force | Out-Null
  $installId = [Guid]::NewGuid().ToString()
  $sentinels = @{
    'vast-data.json' = '{"schemaVersion":8,"bookmarks":[{"title":"preserve-0.1.5"}],"tabs":[{"url":"https://example.test"}]}'
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

  $downloadDir = Join-Path $testRoot 'update-download'
  $bootstrapLog = Join-Path $testRoot 'bootstrapper.log'
  $updaterArguments = @(
    '--manifest-url', "`"$currentManifest`"",
    '--install-path', "`"$installPath`"",
    '--user-data-root', "`"$userData`"",
    '--download-dir', "`"$downloadDir`"",
    '--bootstrap-log-path', "`"$bootstrapLog`"",
    '--non-interactive'
  )
  $process = Start-Process -FilePath $currentUpdater -ArgumentList $updaterArguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    $diagnostic = if (Test-Path -LiteralPath $bootstrapLog -PathType Leaf) { (Get-Content -Raw -LiteralPath $bootstrapLog).Trim() } else { 'bootstrapper log was not created' }
    throw "Assertion failed: local 0.2.5 updater must complete successfully. Exit code $($process.ExitCode).`n$diagnostic"
  }

  $installedVersion = (Get-Content -Raw -LiteralPath (Join-Path $installPath 'version.json') | ConvertFrom-Json).version
  Assert-Equal $CurrentVersion $installedVersion 'runtime must advance from real public 0.1.5 to local 0.2.5'
  foreach ($entry in $sentinels.GetEnumerator()) {
    Assert-Equal $before[$entry.Key] (Get-FileHash -LiteralPath (Join-Path $userData $entry.Key) -Algorithm SHA256).Hash "$($entry.Key) must be preserved byte-for-byte"
  }
  $relay = Get-Content -Raw -LiteralPath (Join-Path $userData 'vast-relay-state.json') | ConvertFrom-Json
  Assert-Equal $installId $relay.install_id 'Relay install identity must survive the upgrade'
  Assert-Equal 17 $relay.launch_count 'the updater must not mutate the Relay launch count'
  Write-Host 'Verified immutable public 0.1.5 installer -> local 0.2.5 with profile and Relay identity preservation.'
} finally {
  $uninstaller = Join-Path $installPath 'Uninstall Vast.exe'
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
