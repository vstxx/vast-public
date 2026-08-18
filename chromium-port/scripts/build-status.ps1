. (Join-Path $PSScriptRoot 'common.ps1')

$activePath = Join-Path (Get-VastPortRoot) '.reports\active-build.json'
if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) {
  throw 'No active-build metadata exists.'
}

$active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
$process = Get-Process -Id $active.processId -ErrorAction SilentlyContinue
$stdoutTail = if (Test-Path -LiteralPath $active.stdout) { @(Get-Content -LiteralPath $active.stdout -Tail 120) } else { @() }
$stderrTail = if (Test-Path -LiteralPath $active.stderr) { @(Get-Content -LiteralPath $active.stderr -Tail 60) } else { @() }
$progressLine = [string](@($stdoutTail | Where-Object { $_ -match '^\[\d+/\d+\]' } | Select-Object -Last 1))
$completed = $null
$total = $null
$remaining = $null
$percent = $null
if ($progressLine -match '^\[(\d+)/(\d+)\]') {
  $completed = [int64]$matches[1]
  $total = [int64]$matches[2]
  $remaining = $total - $completed
  $percent = [math]::Round(100 * $completed / $total, 2)
}
$resumedAfterActions = if ($active.PSObject.Properties.Name -contains 'resumedAfterActions') {
  [int64]$active.resumedAfterActions
} else { 0 }
$startedAt = [datetimeoffset]::Parse($active.startedAt)
$executable = Join-Path (Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)) 'chrome.exe'
$failureLine = [string](@(($stdoutTail + $stderrTail) | Where-Object {
  $_ -match '(?i)(FAILED:|ninja: build stopped|build failed)'
} | Select-Object -Last 1))

[pscustomobject][ordered]@{
  running = [bool]$process
  processId = $active.processId
  target = $active.target
  jobs = $active.jobs
  elapsedMinutes = [math]::Round(((Get-Date).ToUniversalTime() - $startedAt.UtcDateTime).TotalMinutes, 1)
  completedEdges = $completed
  totalEdgesThisRun = $total
  remainingEdges = $remaining
  completedActionsAcrossRuns = $(if ($null -ne $completed) { $resumedAfterActions + $completed } else { $resumedAfterActions })
  progressPercent = $percent
  lastProgress = $progressLine
  failure = $failureLine
  executablePresent = Test-Path -LiteralPath $executable -PathType Leaf
  freeDiskGB = [math]::Round((Get-PSDrive -Name ([System.IO.Path]::GetPathRoot((Get-VastChromiumSrc)).TrimEnd('\').TrimEnd(':'))).Free / 1GB, 1)
} | ConvertTo-Json -Depth 4
