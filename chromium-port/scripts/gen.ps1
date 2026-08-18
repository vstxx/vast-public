param([switch] $PrintArgsOnly)

. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-VastDepotEnvironment
$src = Get-VastChromiumSrc
$out = Get-VastChromiumOut
if (-not (Test-Path -LiteralPath (Join-Path $src '.git'))) { throw "Chromium checkout not found: $src" }

$gnArgs = @(
  'is_debug = false'
  'is_component_build = true'
  'target_cpu = "x64"'
  'is_chrome_branded = false'
  'is_vast_branded = true'
  'symbol_level = 0'
  'blink_symbol_level = 0'
  'v8_symbol_level = 0'
  'use_remoteexec = false'
)
$argsText = $gnArgs -join "`n"
if ($PrintArgsOnly) { Write-Output $argsText; exit 0 }

$outPath = Join-Path $src $out
New-Item -ItemType Directory -Path $outPath -Force | Out-Null
Set-Content -LiteralPath (Join-Path $outPath 'args.gn') -Value "$argsText`n" -Encoding ascii
Invoke-VastNative 'gn.bat' @('gen', $out) $src
& (Join-Path $PSScriptRoot 'pin-sdk-tools.ps1') -EnvironmentFile (Join-Path $outPath 'environment.x64')
Write-Host "GN generated: $outPath"
