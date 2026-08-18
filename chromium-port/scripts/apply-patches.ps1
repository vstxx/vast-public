. (Join-Path $PSScriptRoot 'common.ps1')

$src = Get-VastChromiumSrc
$revision = Read-VastChromiumRevision
$series = Get-Content -LiteralPath (Join-Path (Get-VastPortRoot) 'patches\series.json') -Raw | ConvertFrom-Json
if ($series.schemaVersion -ne 1) { throw 'Unsupported patch series schema.' }
if (-not (Test-Path -LiteralPath (Join-Path $src '.git'))) { throw "Chromium checkout not found: $src" }
$actual = (& git -C $src rev-parse HEAD).Trim()
if ($actual -ne $revision.commit) { throw "Expected Chromium $($revision.commit), got $actual" }
$patchRoot = Join-Path (Get-VastPortRoot) 'patches'
$entries = @($series.patches)

if (-not (Test-VastPatchSeriesAppliesToHead $src $entries $patchRoot)) {
  throw 'Patch series does not apply sequentially to the pinned Chromium commit.'
}
if (Test-VastPatchSeriesApplied $src $entries $patchRoot) {
  foreach ($entry in $entries) { Write-Host "SKIP already applied: $($entry.file)" }
  Write-Host "Patch application complete ($($entries.Count) patches)."
  return
}

foreach ($entry in $entries) {
  $patch = Join-Path $patchRoot $entry.file
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & git -C $src apply --reverse --check $patch 2>$null
  $reverseExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($reverseExitCode -eq 0) {
    Write-Host "SKIP already applied: $($entry.file)"
    continue
  }
  & git -C $src apply --check $patch
  if ($LASTEXITCODE -ne 0) { throw "Patch conflict: $($entry.file)" }
  Invoke-VastNative 'git' @('-C', $src, 'apply', '--index', $patch)
  Write-Host "APPLIED $($entry.file)"
}
Write-Host "Patch application complete ($($entries.Count) patches)."
