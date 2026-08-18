param(
  [string]$ExePath = (Join-Path $PSScriptRoot '..\.vast-test-artifacts\final-polish-test-final-native\win-unpacked\Vast.exe'),
  [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath($PathValue)
}

$resolvedExe = Resolve-FullPath $ExePath
if (-not (Test-Path -LiteralPath $resolvedExe -PathType Leaf)) {
  throw "Google Auth test executable not found: $resolvedExe"
}

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $ProfilePath = Join-Path $env:LOCALAPPDATA "Vast\GoogleAuthTestProfiles\$stamp"
}

$resolvedProfile = Resolve-FullPath $ProfilePath
$productionProfile = Resolve-FullPath (Join-Path $env:APPDATA 'Vast')
$comparison = [System.StringComparison]::OrdinalIgnoreCase
if (
  $resolvedProfile.Equals($productionProfile, $comparison) -or
  $resolvedProfile.StartsWith($productionProfile + [System.IO.Path]::DirectorySeparatorChar, $comparison)
) {
  throw "Refusing to use the production Vast data directory: $resolvedProfile"
}

New-Item -ItemType Directory -Path $resolvedProfile -Force | Out-Null
$markerPath = Join-Path $resolvedProfile '.vast-google-auth-test-profile'
Set-Content -LiteralPath $markerPath -Value "Created $(Get-Date -Format o) for Vast Google Auth testing." -Encoding UTF8

$previousUserData = $env:VAST_TEST_USER_DATA_DIR
$previousUpdateEnabled = $env:VAST_UPDATE_ENABLED
try {
  $env:VAST_TEST_USER_DATA_DIR = $resolvedProfile
  $env:VAST_UPDATE_ENABLED = '0'
  Write-Host "Launching internal Vast Google Auth build."
  Write-Host "Disposable profile: $resolvedProfile"
  Write-Host "Redacted auth log: $(Join-Path $resolvedProfile 'Logs\google-auth.log')"
  Write-Host 'Reuse this same -ProfilePath for the restart-persistence test.'
  Start-Process -FilePath $resolvedExe -Wait
} finally {
  $env:VAST_TEST_USER_DATA_DIR = $previousUserData
  $env:VAST_UPDATE_ENABLED = $previousUpdateEnabled
}
