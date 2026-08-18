$ErrorActionPreference = 'Stop'

$portRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-stage-test-" + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $tempRoot 'src'
$output = Join-Path $sourceRoot 'out\VastDev'
$destination = Join-Path $tempRoot 'stage'
$runtimeDepsPath = Join-Path $tempRoot 'chrome-runtime-deps.txt'
$previousSource = $env:VAST_CHROMIUM_SRC

try {
  New-Item -ItemType Directory -Path (Join-Path $output 'locales') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $output 'IwaKeyDistribution') -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $output 'chrome.exe'), 'fixture executable')
  [System.IO.File]::WriteAllText((Join-Path $output 'chrome.dll'), 'fixture component')
  [System.IO.File]::WriteAllText((Join-Path $output '150.0.7871.125.manifest'), 'fixture side-by-side manifest')
  [System.IO.File]::WriteAllText((Join-Path $output 'chrome.VisualElementsManifest.xml'), 'fixture visual elements')
  [System.IO.File]::WriteAllText((Join-Path $output 'locales\en-US.pak'), 'fixture locale')
  [System.IO.File]::WriteAllText((Join-Path $output 'IwaKeyDistribution\manifest.json'), 'fixture component manifest')
  [System.IO.File]::WriteAllText((Join-Path $output 'chrome.dll.pdb'), 'fixture debug symbols')
  [System.IO.File]::WriteAllLines($runtimeDepsPath, @(
    'chrome.exe',
    './chrome.dll',
    '150.0.7871.125.manifest',
    'chrome.VisualElementsManifest.xml',
    'locales/en-US.pak',
    'IwaKeyDistribution/manifest.json',
    'chrome.dll.pdb'
  ))
  [System.IO.File]::WriteAllText((Join-Path $sourceRoot 'LICENSE'), 'fixture Chromium license')

  $env:VAST_CHROMIUM_SRC = $sourceRoot
  & (Join-Path $portRoot 'scripts\stage-artifacts.ps1') -Destination $destination -RuntimeDepsPath $runtimeDepsPath | Out-Null
  & (Join-Path $portRoot 'scripts\stage-artifacts.ps1') -Destination $destination -RuntimeDepsPath $runtimeDepsPath | Out-Null

  foreach ($relativePath in @(
    'Vast.exe',
    'chrome.exe',
    'chrome.dll',
    '150.0.7871.125.manifest',
    'chrome.VisualElementsManifest.xml',
    'Vast.VisualElementsManifest.xml',
    'locales\en-US.pak',
    'IwaKeyDistribution\manifest.json',
    'vast-product.json',
    'vast-runtime-deps.json',
    'NOTICE.md',
    'LICENSE.chromium.txt'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $destination $relativePath) -PathType Leaf)) {
      throw "Staged development package is missing $relativePath."
    }
  }
  if ((Get-Content -LiteralPath (Join-Path $destination 'Vast.exe') -Raw) -ne 'fixture executable') {
    throw 'Vast.exe is not a byte-for-byte staged copy of the built browser executable.'
  }
  if (Test-Path -LiteralPath (Join-Path $destination 'locales\locales') -PathType Container) {
    throw 'Repeated staging nested the locales directory.'
  }
  if (Test-Path -LiteralPath (Join-Path $destination 'chrome.dll.pdb') -PathType Leaf) {
    throw 'Debug symbols were staged without -IncludeSymbols.'
  }
  $runtimeManifest = Get-Content -LiteralPath (Join-Path $destination 'vast-runtime-deps.json') -Raw | ConvertFrom-Json
  if ($runtimeManifest.dependencyCount -ne 6 -or $runtimeManifest.excludedDebugFileCount -ne 1) {
    throw 'The staged runtime dependency manifest has unexpected counts.'
  }
  $sandboxAcl = (Get-Acl -LiteralPath (Join-Path $destination 'chrome.exe')).Sddl
  if ($sandboxAcl -notmatch '\(A;[^;]*;[^;]+;;;S-1-15-2-2\)') {
    throw 'The staged executable is not readable by Chromium AppContainer sandboxes.'
  }

  Write-Host 'PASS Chromium development artifact staging fixture'
} finally {
  $env:VAST_CHROMIUM_SRC = $previousSource
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
