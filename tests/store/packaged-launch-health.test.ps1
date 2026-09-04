param(
  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,
  [string] $ProfileRoot,
  [ValidateRange(10, 120)]
  [int] $MinimumUptimeSeconds = 20
)

$ErrorActionPreference = 'Stop'
$executable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
  $ProfileRoot = Join-Path ([IO.Path]::GetTempPath()) ("vast-packaged-launch-{0}" -f [Guid]::NewGuid().ToString('N'))
}

function Get-VastApplicationErrors([datetime] $Since) {
  @(Get-WinEvent -FilterHashtable @{
      LogName = 'Application'
      ProviderName = 'Application Error'
      Id = 1000
      StartTime = $Since
    } -ErrorAction SilentlyContinue | Where-Object {
      $_.Properties.Count -gt 10 -and
      [string]::Equals([string] $_.Properties[10].Value, $executable, [StringComparison]::OrdinalIgnoreCase)
    })
}

$previousProfile = [Environment]::GetEnvironmentVariable('VAST_TEST_USER_DATA_DIR', 'Process')
$process = $null
$startedAt = (Get-Date).AddSeconds(-1)
[Environment]::SetEnvironmentVariable('VAST_TEST_USER_DATA_DIR', $ProfileRoot, 'Process')

try {
  # Deliberately use the production GPU path. Passing --disable-gpu here would
  # hide AppX/MSIX GPU-process regressions such as Electron #53198.
  $process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
  if ($process.WaitForExit($MinimumUptimeSeconds * 1000)) {
    Start-Sleep -Milliseconds 750
    $errors = @(Get-VastApplicationErrors $startedAt)
    $detail = if ($errors.Count) {
      $latest = $errors | Sort-Object TimeCreated -Descending | Select-Object -First 1
      " Application Error $($latest.Id), exception $($latest.Properties[6].Value), report $($latest.Properties[12].Value)."
    } else { '' }
    throw "Packaged Vast exited before the $MinimumUptimeSeconds-second production-GPU health window with code $($process.ExitCode).$detail"
  }

  $ownedProcesses = @(Get-Process -Name Vast -ErrorAction SilentlyContinue | Where-Object {
      try { [string]::Equals($_.Path, $executable, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
  if ($ownedProcesses.Count -lt 2) {
    throw "Packaged Vast did not create a renderer or utility child process; found $($ownedProcesses.Count) candidate process(es)."
  }

  $errors = @(Get-VastApplicationErrors $startedAt)
  if ($errors.Count) {
    throw "Packaged Vast produced $($errors.Count) Application Error event(s) during the production-GPU health window."
  }

  [ordered]@{
    ok = $true
    executable = $executable
    productVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
    minimumUptimeSeconds = $MinimumUptimeSeconds
    processCount = $ownedProcesses.Count
    applicationErrors = 0
    gpuDisabled = $false
    profileRoot = $ProfileRoot
  } | ConvertTo-Json
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  [Environment]::SetEnvironmentVariable('VAST_TEST_USER_DATA_DIR', $previousProfile, 'Process')
}
