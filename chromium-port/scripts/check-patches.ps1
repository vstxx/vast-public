. (Join-Path $PSScriptRoot 'common.ps1')

$src = Get-VastChromiumSrc
$revision = Read-VastChromiumRevision
$seriesPath = Join-Path (Get-VastPortRoot) 'patches\series.json'
$series = Get-Content -LiteralPath $seriesPath -Raw | ConvertFrom-Json
if ($series.schemaVersion -ne 1) { throw 'Unsupported patch series schema.' }
if (-not (Test-Path -LiteralPath (Join-Path $src '.git'))) { throw "Chromium checkout not found: $src" }

$actual = (& git -C $src rev-parse HEAD).Trim()
if ($actual -ne $revision.commit) { throw "Expected Chromium $($revision.commit), got $actual" }
$patchRoot = Join-Path (Get-VastPortRoot) 'patches'
$entries = @($series.patches)

foreach ($entry in $entries) {
  $patch = Join-Path $patchRoot $entry.file
  if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) { throw "Missing patch: $patch" }
}

if (-not (Test-VastPatchSeriesAppliesToHead $src $entries $patchRoot)) {
  throw 'Patch series does not apply sequentially to the pinned Chromium commit.'
}
$state = if (Test-VastPatchSeriesApplied $src $entries $patchRoot) { 'already applied' } else { 'applicable from HEAD' }
Write-Host "Patch check passed ($($entries.Count) patches; $state)."
