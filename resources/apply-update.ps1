param([Parameter(Mandatory=$true)][string] $RecordPath, [Parameter(Mandatory=$true)][string] $LaunchPath, [Parameter(Mandatory=$true)][string] $ArgumentsPath, [int] $ParentProcessId, [switch] $Handshake, [switch] $Worker, [string] $ReadyToken)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Quote-Argument([string] $Value) {
  '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

# PowerShell started directly by Electron is torn down with its parent on some
# Windows sessions. ShellExecute a separate waiter, then acknowledge only after
# that waiter has opened and validated the staged update.
if ($Handshake -and -not $Worker) {
  $readyPath = $RecordPath + '.ready'
  $token = [guid]::NewGuid().ToString('N')
  Remove-Item -LiteralPath $readyPath -ErrorAction SilentlyContinue
  $workerArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Argument $PSCommandPath),
    '-RecordPath', (Quote-Argument $RecordPath), '-LaunchPath', (Quote-Argument $LaunchPath),
    '-ArgumentsPath', (Quote-Argument $ArgumentsPath), '-ParentProcessId', [string]$ParentProcessId,
    '-Worker', '-ReadyToken', $token
  )
  $waiter = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList ($workerArgs -join ' ') -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if ([IO.File]::ReadAllText($readyPath) -ceq $token) {
        [Console]::Out.WriteLine('VAST_UPDATE_READY')
        [Console]::Out.Flush()
        exit 0
      }
    } catch [IO.IOException] {}
    if ($waiter.HasExited) { exit 1 }
    Start-Sleep -Milliseconds 50
  }
  exit 1
}

$launchArgs = @()
$lock = $null
$accepted = $false
$parentClosed = $false
try {
  $lock = [IO.File]::Open($RecordPath + '.lock', 'OpenOrCreate', 'ReadWrite', 'None')
  $launchArgs = @(Get-Content -LiteralPath $ArgumentsPath -Raw | ConvertFrom-Json)
  $record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
  if ($record.executable -cne $LaunchPath -or [int]$record.attempts -ge 3) { throw 'Invalid or exhausted update handoff.' }
  $accepted = $true
  if ($Worker) {
    if ($ReadyToken -notmatch '^[a-f0-9]{32}$') { throw 'Invalid worker readiness token.' }
    [IO.File]::WriteAllText($RecordPath + '.ready.tmp', $ReadyToken)
    Move-Item -LiteralPath ($RecordPath + '.ready.tmp') -Destination ($RecordPath + '.ready') -Force
  }
  $parentProcess = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
  if ($parentProcess -and -not $parentProcess.WaitForExit(30000)) { throw 'Vast did not finish closing.' }
  $parentClosed = $true
  $record.attempts = [int]$record.attempts + 1
  $record | ConvertTo-Json -Compress | Set-Content -LiteralPath ($RecordPath + '.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($RecordPath + '.tmp') -Destination $RecordPath -Force
  $stream = [IO.File]::OpenRead($record.installer)
  $hasher = [Security.Cryptography.SHA512]::Create()
  try { $hash = [Convert]::ToBase64String($hasher.ComputeHash($stream)) } finally { $stream.Dispose(); $hasher.Dispose() }
  if ($hash -cne $record.sha512) { throw 'The prepared update failed its SHA-512 check.' }
  # NSIS /D must be the last argument and must not be quoted internally.
  $installArgs = '/S --updated /D=' + [IO.Path]::GetDirectoryName($LaunchPath)
  $installer = Start-Process -FilePath $record.installer -ArgumentList $installArgs -WindowStyle Hidden -PassThru -Wait
  if ($installer.ExitCode -ne 0) { throw ('Installer deferred or failed with code ' + $installer.ExitCode) }
} catch {
  try { $_.Exception.Message | Set-Content -LiteralPath ($RecordPath + '.error') -Encoding UTF8 } catch {}
} finally {
  if ($lock) { $lock.Dispose() }
}
if (($Handshake -or $Worker) -and (-not $accepted -or -not $parentClosed)) { exit 1 }
# Never loop automatically after a failed installer; the old browser remains usable.
$arguments = @($launchArgs | Where-Object { $_ -ne '--vast-after-update' } | ForEach-Object { Quote-Argument ([string]$_) })
$arguments += '--vast-after-update'
Start-Process -FilePath $LaunchPath -ArgumentList ($arguments -join ' ') -WorkingDirectory ([IO.Path]::GetDirectoryName($LaunchPath)) -WindowStyle Hidden
