param(
  [string] $Destination,
  [switch] $KeepProfiles,
  [switch] $SkipGoogleNavigation
)

. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $Destination) {
  $Destination = Join-Path (Get-VastChromiumArtifactRoot) 'Vast-2.0.0-dev-win-x64'
}
$Destination = [System.IO.Path]::GetFullPath($Destination)

& (Join-Path $PSScriptRoot 'stage-artifacts.ps1') -Destination $Destination
$executable = Join-Path $Destination 'Vast.exe'
$launchReport = New-VastReportPath 'launch-smoke'
$capabilityReport = New-VastReportPath 'capability-smoke'
$vastWebUIReport = New-VastReportPath 'vast-webui-smoke'
$vastToolbarReport = New-VastReportPath 'vast-toolbar-smoke'
$buildReport = New-VastReportPath 'build'

$smokeArguments = @{ Executable = $executable; ReportPath = $launchReport; TimeoutSeconds = 300 }
if ($KeepProfiles) { $smokeArguments.KeepProfile = $true }
if ($SkipGoogleNavigation) { $smokeArguments.SkipGoogleNavigation = $true }
& (Join-Path $PSScriptRoot 'smoke-test.ps1') @smokeArguments

$capabilityArguments = @{ Executable = $executable; ReportPath = $capabilityReport }
if ($KeepProfiles) { $capabilityArguments.KeepProfile = $true }
& (Join-Path $PSScriptRoot 'capability-smoke-test.ps1') @capabilityArguments

$webUIArguments = @{ Executable = $executable; ReportPath = $vastWebUIReport }
if ($KeepProfiles) { $webUIArguments.KeepProfile = $true }
& (Join-Path $PSScriptRoot 'vast-webui-smoke-test.ps1') @webUIArguments

$toolbarArguments = @{
  Executable = $executable
  ReportPath = $vastToolbarReport
  TimeoutSeconds = 300
  WorkspaceMenuFixture = $true
}
if ($KeepProfiles) { $toolbarArguments.KeepProfile = $true }
& (Join-Path $PSScriptRoot 'vast-toolbar-smoke-test.ps1') @toolbarArguments

& (Join-Path $PSScriptRoot 'build-report.ps1') -Executable $executable -ReportPath $buildReport

$versionInfo = (Get-Item -LiteralPath $executable).VersionInfo
if ($versionInfo.ProductName -ne 'Vast') {
  throw "Unexpected executable product name: $($versionInfo.ProductName)"
}

$acceptanceReport = New-VastReportPath 'phase2-acceptance'
[ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  executable = $executable
  executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
  productName = $versionInfo.ProductName
  launchSmokeReport = $launchReport
  capabilitySmokeReport = $capabilityReport
  vastWebUIReport = $vastWebUIReport
  vastToolbarReport = $vastToolbarReport
  buildReport = $buildReport
  passed = $true
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $acceptanceReport -Encoding utf8

Write-Host "PASS verified staged native Vast build: $executable; report=$acceptanceReport"
