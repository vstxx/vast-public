[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$BackgroundRoot = Join-Path $Root '.vast-build\password-manager-gates\background\proton-natural-idle'
$LogPath = Join-Path $BackgroundRoot 'process.log'
$ErrorLogPath = Join-Path $BackgroundRoot 'process-error.log'
$StatusPath = Join-Path $BackgroundRoot 'status'
$ExitCodePath = Join-Path $BackgroundRoot 'exit-code'
$LauncherPath = Join-Path $BackgroundRoot 'launcher.json'

New-Item -ItemType Directory -Path $BackgroundRoot -Force | Out-Null
Remove-Item -LiteralPath $ExitCodePath -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($StatusPath, 'running')
$CommandText = "node scripts/password-manager-gate/probe-proton-natural-idle.cjs $RunId"
$Wrapper = "& node scripts/password-manager-gate/probe-proton-natural-idle.cjs $RunId; " +
  "`$probeExitCode=`$LASTEXITCODE; " +
  "[IO.File]::WriteAllText('$($ExitCodePath.Replace("'", "''"))',[string]`$probeExitCode); " +
  "[IO.File]::WriteAllText('$($StatusPath.Replace("'", "''"))',[string]`$probeExitCode); " +
  'exit $probeExitCode'
$Process = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Wrapper) `
  -WorkingDirectory $Root -WindowStyle Hidden `
  -RedirectStandardOutput $LogPath -RedirectStandardError $ErrorLogPath -PassThru

[ordered]@{
  command = $CommandText
  pid = $Process.Id
  startedAt = [DateTime]::UtcNow.ToString('o')
  log = $LogPath
  errorLog = $ErrorLogPath
  status = $StatusPath
  exitCode = $ExitCodePath
  etaSeconds = 180
} | ConvertTo-Json | Set-Content -LiteralPath $LauncherPath -Encoding UTF8

Get-Content -LiteralPath $LauncherPath -Raw
