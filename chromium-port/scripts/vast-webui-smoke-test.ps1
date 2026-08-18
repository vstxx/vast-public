param(
  [string] $Executable,
  [switch] $KeepProfile,
  [string] $ReportPath,
  [string] $ScreenshotPath,
  [string] $BackupFixture
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Executable) {
  $out = Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)
  $vast = Join-Path $out 'Vast.exe'
  $Executable = if (Test-Path -LiteralPath $vast) { $vast } else { Join-Path $out 'chrome.exe' }
}
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Browser executable not found: $Executable" }
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'vast-webui-smoke' }
if (-not $ScreenshotPath) { $ScreenshotPath = [System.IO.Path]::ChangeExtension($ReportPath, '.png') }

$test = Join-Path (Get-VastPortRoot) 'tests\vast-webui-smoke.mjs'
$arguments = @($test, "--executable=$Executable", "--screenshot=$ScreenshotPath")
if ($KeepProfile) { $arguments += '--keep-profile' }
if ($BackupFixture) { $arguments += "--backup-fixture=$([System.IO.Path]::GetFullPath($BackupFixture))" }
$output = @(Invoke-VastNative 'node.exe' $arguments (Get-VastRepositoryRoot))
$jsonLine = $output | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
if (-not $jsonLine) { throw 'Vast WebUI smoke harness did not return its JSON result.' }
$result = $jsonLine | ConvertFrom-Json
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
Write-Host "PASS chrome://vast WebUI smoke; report=$ReportPath; screenshot=$ScreenshotPath"
