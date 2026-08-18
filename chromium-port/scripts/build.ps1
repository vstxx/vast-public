param(
  [ValidateSet('chrome', 'mini_installer', 'chrome_tests', 'chrome/browser/vast:vast_data_unittests', 'chrome/browser/vast:vast_backup_audit')]
  [string] $Target = 'chrome',
  [int] $Jobs = 8,
  [switch] $SkipGnGeneration
)

. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-VastDepotEnvironment
$src = Get-VastChromiumSrc
$out = Get-VastChromiumOut
if (-not (Test-Path -LiteralPath (Join-Path $src $out))) { throw 'GN output is missing. Run gen.ps1 first.' }
if (-not $SkipGnGeneration) {
  Invoke-VastNative 'gn.bat' @('gen', $out) $src
}
& (Join-Path $PSScriptRoot 'pin-sdk-tools.ps1') `
  -EnvironmentFile (Join-Path (Join-Path $src $out) 'environment.x64')
$arguments = @('-C', $out, $Target)
if ($Jobs -gt 0) { $arguments += @('-j', $Jobs.ToString()) }
$env:NINJA_SUMMARIZE_BUILD = '1'
Invoke-VastNative 'autoninja.bat' $arguments $src
Write-Host "Built //chrome target '$Target' in $out"
