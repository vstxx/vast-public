[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$DebuggerPort = 14950,

  [switch]$EnableGateFixtures
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$BackgroundRoot = Join-Path $Root '.vast-build\password-manager-gates\background\icloud'
$Profile = Join-Path $Root '.vast-build\password-manager-gates\profiles\icloud'
$Electron = if ($env:VAST_PATCHED_ELECTRON_EXE) {
  [IO.Path]::GetFullPath($env:VAST_PATCHED_ELECTRON_EXE)
} else {
  'D:\VastElectron44\src\out\VastCompat\electron.exe'
}
$LauncherPath = Join-Path $BackgroundRoot 'launcher.json'
$StatusPath = Join-Path $BackgroundRoot 'status'
$ExitCodePath = Join-Path $BackgroundRoot 'exit-code'
$LogPath = Join-Path $BackgroundRoot 'process.log'
$ErrorLogPath = Join-Path $BackgroundRoot 'process-error.log'
$FixtureResolverRules = 'MAP login.vast-test.local 127.0.0.1, MAP spa.vast-test.local 127.0.0.1, MAP dynamic.vast-test.local 127.0.0.1, MAP iframe.vast-test.local 127.0.0.1'

New-Item -ItemType Directory -Force -Path $BackgroundRoot | Out-Null
if (Test-Path -LiteralPath $LauncherPath) {
  try {
    $existing = Get-Content -Raw -LiteralPath $LauncherPath | ConvertFrom-Json
    if ($existing.wrapperPid -and (Get-Process -Id $existing.wrapperPid -ErrorAction SilentlyContinue)) {
      throw "An iCloud interactive launcher is already running as PID $($existing.wrapperPid)."
    }
  } catch {
    if ($_.Exception.Message -like 'An iCloud interactive launcher*') { throw }
  }
}
if (-not (Test-Path -LiteralPath $Electron)) { throw "Patched Electron is missing: $Electron" }
if (-not (Test-Path -LiteralPath (Join-Path $Profile 'Extensions\registry.json'))) {
  throw 'The authenticated iCloud extension profile is not prepared.'
}

Remove-Item -LiteralPath $ExitCodePath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $StatusPath -Value 'starting' -Encoding ascii
$env:VAST_TEST_USER_DATA_DIR = $Profile
$env:VAST_EXTENSION_COMPATIBILITY = '1'
$env:VAST_PATCHED_ELECTRON_COMPAT = '1'
$env:VAST_PATCHED_ELECTRON_DIST = Split-Path -Parent $Electron
$env:VAST_RELAY_ENABLED = '0'
$env:VAST_RELAY_TEST_OFFLINE = '1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$electronArguments = @("--remote-debugging-port=$DebuggerPort")
if ($EnableGateFixtures) {
  $electronArguments += '--host-resolver-rules="' + $FixtureResolverRules + '"'
}
$electronArguments += '"' + $Root + '"'

$child = Start-Process -FilePath $Electron `
  -ArgumentList $electronArguments `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError $ErrorLogPath `
  -PassThru

[ordered]@{
  schemaVersion = 1
  wrapperPid = $PID
  electronPid = $child.Id
  debuggerPort = $DebuggerPort
  profile = $Profile
  gateFixturesEnabled = [bool]$EnableGateFixtures
  startedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $LauncherPath -Encoding utf8
Set-Content -LiteralPath $StatusPath -Value 'running' -Encoding ascii

$child.WaitForExit()
$child.ExitCode | Set-Content -LiteralPath $ExitCodePath -Encoding ascii
Set-Content -LiteralPath $StatusPath -Value 'stopped' -Encoding ascii
exit $child.ExitCode
