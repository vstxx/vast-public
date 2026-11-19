# Samples a browser's process tree until the stop file appears: CPU time,
# private bytes and per-adapter GPU engine running time (cumulative counters,
# so the harness can difference them). One JSON object per line.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$Output,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [int]$IntervalMs = 1000
)
$ErrorActionPreference = 'SilentlyContinue'
while (-not (Test-Path $StopFile)) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, KernelModeTime, UserModeTime, PrivatePageCount, WorkingSetSize, CommandLine, Name
  $children = @{}
  foreach ($p in $all) { if (-not $children.ContainsKey([int]$p.ParentProcessId)) { $children[[int]$p.ParentProcessId] = @() }; $children[[int]$p.ParentProcessId] += $p }
  $tree = @{}
  $queue = New-Object System.Collections.Queue
  $root = $all | Where-Object { $_.ProcessId -eq $RootPid }
  if (-not $root) { break }
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    $type = 'browser'
    if ($p.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
    if ($type -eq 'utility' -and $p.CommandLine -match '--utility-sub-type=([A-Za-z.]+)') { $type = "utility:$($Matches[1])" }
    $tree[[string]$p.ProcessId] = @{ type = $type; cpu100ns = [double]$p.KernelModeTime + [double]$p.UserModeTime; privateBytes = [double]$p.PrivatePageCount; workingSet = [double]$p.WorkingSetSize }
    foreach ($c in $children[[int]$p.ProcessId]) { $queue.Enqueue($c) }
  }
  $gpu = @{}
  $counters = Get-Counter -Counter '\GPU Engine(*)\Running Time' -MaxSamples 1
  foreach ($s in $counters.CounterSamples) {
    if ($s.InstanceName -match '^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_(\d+)_engtype_(.+)$') {
      if ($tree.ContainsKey($Matches[1])) {
        $key = "$($Matches[1])|$($Matches[2])|$($Matches[4])"
        if (-not $gpu.ContainsKey($key)) { $gpu[$key] = 0.0 }
        $gpu[$key] += [double]$s.RawValue
      }
    }
  }
  $line = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $tree; gpuRunning100ns = $gpu } | ConvertTo-Json -Compress -Depth 4
  Add-Content -Path $Output -Value $line -Encoding utf8
  Start-Sleep -Milliseconds $IntervalMs
}
