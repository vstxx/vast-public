param(
  [string] $PackagePath,
  [string] $ReportPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $candidate = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'release\store') -Filter 'Vast-*-Store-x64.msix' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $candidate) { throw 'No production Store MSIX was found. Pass -PackagePath explicitly.' }
  $PackagePath = $candidate.FullName
}
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
  $ReportPath = Join-Path $repoRoot 'release\store\wack-report.xml'
}
$reportDirectory = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null

$appcertCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\App Certification Kit\appcert.exe'),
  (Join-Path $env:ProgramFiles 'Windows Kits\10\App Certification Kit\appcert.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$appcert = $appcertCandidates | Select-Object -First 1
if (-not $appcert) {
  [ordered]@{
    ok = $false
    status = 'BLOCKED'
    reason = 'Current Windows App Certification Kit is not installed.'
    package = $resolvedPackage
  } | ConvertTo-Json
  exit 2
}

$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = [Security.Principal.WindowsPrincipal]::new($windowsIdentity)
if (-not $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [ordered]@{
    ok = $false
    status = 'BLOCKED'
    reason = 'Windows App Certification Kit must be run from an elevated PowerShell session.'
    package = $resolvedPackage
    appcert = $appcert
  } | ConvertTo-Json
  exit 2
}

& $appcert reset | Out-Host
if ($LASTEXITCODE -ne 0) { throw "appcert reset failed with exit code $LASTEXITCODE." }
& $appcert test -appxpackagepath $resolvedPackage -reportoutputpath $ReportPath | Out-Host
$testExitCode = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { throw 'WACK did not produce a report.' }
$report = Get-Content -LiteralPath $ReportPath -Raw
try {
  $reportDocument = [xml] $report
} catch {
  throw "WACK produced an invalid XML report: $($_.Exception.Message)"
}
$reportRoot = $reportDocument.DocumentElement
if (-not $reportRoot -or $reportRoot.LocalName -ne 'REPORT') { throw 'WACK report does not have the expected REPORT root element.' }
$overallResult = $reportRoot.GetAttribute('OVERALL_RESULT').Trim().ToUpperInvariant()
$partialRun = $reportRoot.GetAttribute('PARTIAL_RUN').Trim().ToUpperInvariant()
$failedTests = @($reportDocument.SelectNodes('//TEST') | Where-Object {
    $_.RESULT -and $_.RESULT.InnerText.Trim().ToUpperInvariant() -eq 'FAIL'
  })
$requiredFailedTests = @($failedTests | Where-Object {
    [string] $_.OPTIONAL -ne 'TRUE'
  })
$passed = (
  $testExitCode -eq 0 -and
  $overallResult -eq 'PASS' -and
  $partialRun -eq 'FALSE' -and
  $requiredFailedTests.Count -eq 0
)

[ordered]@{
  ok = $passed
  status = $(if ($passed) { 'PASS' } else { 'FAIL' })
  package = $resolvedPackage
  report = (Resolve-Path -LiteralPath $ReportPath).Path
  exitCode = $testExitCode
  overallResult = $overallResult
  partialRun = $partialRun
  failedTestCount = $failedTests.Count
  requiredFailedTestCount = $requiredFailedTests.Count
  optionalFailedTests = @($failedTests | Where-Object { [string] $_.OPTIONAL -eq 'TRUE' } | ForEach-Object { [string] $_.NAME })
} | ConvertTo-Json

if (-not $passed) { exit 1 }
