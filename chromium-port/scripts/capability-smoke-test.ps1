param(
  [string] $Executable,
  [switch] $KeepProfile,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Executable) {
  $out = Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)
  $vast = Join-Path $out 'Vast.exe'
  $Executable = if (Test-Path -LiteralPath $vast) { $vast } else { Join-Path $out 'chrome.exe' }
}
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Browser executable not found: $Executable" }

$test = Join-Path (Get-VastPortRoot) 'tests\native-capabilities-smoke.mjs'
$arguments = @($test, "--executable=$Executable")
if ($KeepProfile) { $arguments += '--keep-profile' }
$output = @(Invoke-VastNative 'node.exe' $arguments (Get-VastRepositoryRoot))
$jsonLine = $output | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
if (-not $jsonLine) { throw 'Native capability harness did not return its JSON result.' }
$result = $jsonLine | ConvertFrom-Json
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'capability-smoke' }
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
Write-Host "PASS native capability smoke; report=$ReportPath"
