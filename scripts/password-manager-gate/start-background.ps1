[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('bitwarden', 'proton', 'combined')]
  [string]$Mode,

  [ValidateSet('run', 'resume')]
  [string]$Command = 'run',

  [switch]$Exploratory,

  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId
)

$ErrorActionPreference = 'Stop'
if ($Command -eq 'resume' -and [string]::IsNullOrWhiteSpace($RunId)) {
  throw '-RunId is required when -Command is resume.'
}
if ($Command -eq 'run' -and -not [string]::IsNullOrWhiteSpace($RunId)) {
  throw '-RunId is only valid when -Command is resume.'
}
if ($Exploratory -and $Command -ne 'run') {
  throw '-Exploratory is only valid for a new run.'
}
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$BackgroundRoot = Join-Path $Root ".vast-build\password-manager-gates\background\$Mode"
$ProfileLock = Join-Path $Root ".vast-build\password-manager-gates\profiles\$Mode\.vast-password-manager-gate.lock.json"
$MetadataPath = Join-Path $BackgroundRoot 'launcher.json'
$LogPath = Join-Path $BackgroundRoot 'process.log'
$ErrorLogPath = Join-Path $BackgroundRoot 'process-error.log'
$StatusPath = Join-Path $BackgroundRoot 'status'
$ExitCodePath = Join-Path $BackgroundRoot 'exit-code'

function Test-LivePid([int]$ProcessId) {
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

if (Test-Path -LiteralPath $MetadataPath) {
  $existing = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
  if ($existing.controllerPid -and (Test-LivePid $existing.controllerPid)) { throw 'Password-manager gate is already running.' }
}
if (Test-Path -LiteralPath $ProfileLock) {
  $lock = Get-Content -Raw -LiteralPath $ProfileLock | ConvertFrom-Json
  if ($lock.pid -and (Test-LivePid $lock.pid)) { throw 'A live profile lock already owns this profile.' }
}

New-Item -ItemType Directory -Path $BackgroundRoot -Force | Out-Null
Remove-Item -LiteralPath $ExitCodePath -Force -ErrorAction SilentlyContinue
$GateArguments = if ($Command -eq 'resume') { "$Command $Mode --run-id $RunId" } else { "$Command $Mode" }
if ($Exploratory) { $GateArguments += ' --exploratory' }
$CommandText = "node scripts/password-manager-gate.cjs $GateArguments"
$Wrapper = "& node scripts/password-manager-gate.cjs $GateArguments; `$gateExitCode=`$LASTEXITCODE; [IO.File]::WriteAllText('$($ExitCodePath.Replace("'", "''"))',[string]`$gateExitCode); [IO.File]::WriteAllText('$($StatusPath.Replace("'", "''"))',[string]`$gateExitCode); exit `$gateExitCode"
[IO.File]::WriteAllText($StatusPath, 'running')
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Wrapper) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $LogPath -RedirectStandardError $ErrorLogPath -PassThru
[ordered]@{
  command = $CommandText
  gateCommand = $Command
  runId = $RunId
  controllerPid = $process.Id
  startedAt = [DateTime]::UtcNow.ToString('o')
  log = $LogPath
  errorLog = $ErrorLogPath
  status = $StatusPath
  exitCode = $ExitCodePath
} | ConvertTo-Json | Set-Content -LiteralPath $MetadataPath -Encoding UTF8
$process.Id
