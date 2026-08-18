param(
  [string] $Destination,
  [string] $RuntimeDepsPath,
  [switch] $IncludeSymbols
)

. (Join-Path $PSScriptRoot 'common.ps1')
$src = Get-VastChromiumSrc
$outPath = Join-Path $src (Get-VastChromiumOut)
if (-not $Destination) { $Destination = Join-Path (Get-VastChromiumArtifactRoot) 'Vast-2.0.0-dev-win-x64' }
$Destination = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath (Join-Path $outPath 'chrome.exe'))) { throw 'chrome.exe is missing; build //chrome first.' }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

$runtimeDeps = if ($RuntimeDepsPath) {
  Get-Content -LiteralPath ([System.IO.Path]::GetFullPath($RuntimeDepsPath))
} else {
  Initialize-VastDepotEnvironment
  $gn = Join-Path (Get-VastDepotTools) 'gn.bat'
  Push-Location -LiteralPath $src
  try {
    $deps = & $gn desc $outPath '//chrome:chrome' runtime_deps
    if ($LASTEXITCODE -ne 0) { throw "gn desc runtime_deps failed with code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
  $deps
}

$outPrefix = $outPath.TrimEnd('\') + '\'
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$stagedDependencies = [System.Collections.Generic.List[string]]::new()
$excludedDebugFiles = [System.Collections.Generic.List[string]]::new()
foreach ($dependency in $runtimeDeps) {
  $relativePath = ([string] $dependency).Trim().Replace('/', '\')
  if (-not $relativePath) { continue }
  if ($relativePath.StartsWith('.\')) { $relativePath = $relativePath.Substring(2) }
  if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|\\)\.\.(\\|$)') {
    throw "Unsafe Chromium runtime dependency path: $dependency"
  }
  if (-not $seen.Add($relativePath)) { continue }
  if (-not $IncludeSymbols -and [System.IO.Path]::GetExtension($relativePath) -in @('.pdb', '.map')) {
    $excludedDebugFiles.Add($relativePath)
    continue
  }

  $source = [System.IO.Path]::GetFullPath((Join-Path $outPath $relativePath))
  if (-not $source.StartsWith($outPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Chromium runtime dependency escaped the output directory: $dependency"
  }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Chromium runtime dependency is missing: $source"
  }
  $target = Join-Path $Destination $relativePath
  $targetParent = Split-Path -Parent $target
  if ($targetParent) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
  $sourceItem = Get-Item -LiteralPath $source
  $targetItem = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
  if (
    -not $targetItem -or
    $targetItem.Length -ne $sourceItem.Length -or
    $targetItem.LastWriteTimeUtc -ne $sourceItem.LastWriteTimeUtc
  ) {
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  $stagedDependencies.Add($relativePath)
}

Copy-Item -LiteralPath (Join-Path $outPath 'chrome.exe') -Destination (Join-Path $Destination 'Vast.exe') -Force
$visualElements = Join-Path $outPath 'chrome.VisualElementsManifest.xml'
if (Test-Path -LiteralPath $visualElements -PathType Leaf) {
  Copy-Item -LiteralPath $visualElements -Destination (Join-Path $Destination 'Vast.VisualElementsManifest.xml') -Force
}
Copy-Item -LiteralPath (Join-Path (Get-VastPortRoot) 'product.json') -Destination (Join-Path $Destination 'vast-product.json') -Force
Copy-Item -LiteralPath (Join-Path (Get-VastPortRoot) 'branding\NOTICE.md') -Destination (Join-Path $Destination 'NOTICE.md') -Force
$chromiumLicense = Join-Path $src 'LICENSE'
if (-not (Test-Path -LiteralPath $chromiumLicense -PathType Leaf)) { throw "Chromium license is missing: $chromiumLicense" }
Copy-Item -LiteralPath $chromiumLicense -Destination (Join-Path $Destination 'LICENSE.chromium.txt') -Force

[ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  target = '//chrome:chrome'
  sourceOutput = $outPath
  dependencyCount = $stagedDependencies.Count
  includedSymbols = [bool] $IncludeSymbols
  excludedDebugFileCount = $excludedDebugFiles.Count
  dependencies = $stagedDependencies
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Destination 'vast-runtime-deps.json') -Encoding utf8

# Network and other AppContainer-sandboxed Chromium processes must be able to
# read and execute every staged runtime file. Some non-system volumes do not
# inherit this Windows capability ACL, so grant only read/execute on the
# generated artifact directory. Never disable the sandbox to work around it.
& icacls.exe $Destination /grant '*S-1-15-2-2:(OI)(CI)(RX)' /T /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not apply the Chromium sandbox ACL to $Destination." }
Write-Host "Development artifacts staged: $Destination"
