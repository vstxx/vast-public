[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$DebuggerPort = 14951,

  [string]$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$BackgroundRoot = Join-Path $Root '.vast-build\password-manager-gates\background\chrome-icloud'
$Profile = Join-Path $Root '.vast-build\password-manager-gates\profiles\chrome-icloud'
$LauncherPath = Join-Path $BackgroundRoot 'launcher.json'
$StatusPath = Join-Path $BackgroundRoot 'status'
$ExitCodePath = Join-Path $BackgroundRoot 'exit-code'
$LogPath = Join-Path $BackgroundRoot 'process.log'
$ErrorLogPath = Join-Path $BackgroundRoot 'process-error.log'
$ResolverRules = 'MAP login.vast-test.local 127.0.0.1, MAP spa.vast-test.local 127.0.0.1, MAP dynamic.vast-test.local 127.0.0.1, MAP iframe.vast-test.local 127.0.0.1'

$ChromePath = [IO.Path]::GetFullPath($ChromePath)
if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw "Chrome is missing: $ChromePath" }

New-Item -ItemType Directory -Force -Path $BackgroundRoot,$Profile | Out-Null
if (Test-Path -LiteralPath $LauncherPath) {
  try {
    $existing = Get-Content -Raw -LiteralPath $LauncherPath | ConvertFrom-Json
    if ($existing.chromePid -and (Get-Process -Id $existing.chromePid -ErrorAction SilentlyContinue)) {
      throw "An isolated Chrome iCloud baseline is already running as PID $($existing.chromePid)."
    }
  } catch {
    if ($_.Exception.Message -like 'An isolated Chrome iCloud baseline*') { throw }
  }
}

Remove-Item -LiteralPath $ExitCodePath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $StatusPath -Value 'starting' -Encoding ascii
$arguments = @(
  ('--user-data-dir="' + $Profile + '"'),
  "--remote-debugging-port=$DebuggerPort",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  ('--host-resolver-rules="' + $ResolverRules + '"'),
  'https://login.vast-test.local:54446/native-login'
) -join ' '

$child = Start-Process -FilePath $ChromePath `
  -ArgumentList $arguments `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError $ErrorLogPath `
  -PassThru

[ordered]@{
  schemaVersion = 1
  wrapperPid = $PID
  chromePid = $child.Id
  debuggerPort = $DebuggerPort
  profile = $Profile
  extensionId = 'pejdijmoenmkgeppbflobdenhhabjlaj'
  extensionVersion = '3.3.0'
  startedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $LauncherPath -Encoding utf8
Set-Content -LiteralPath $StatusPath -Value 'running' -Encoding ascii

$child.WaitForExit()
$child.ExitCode | Set-Content -LiteralPath $ExitCodePath -Encoding ascii
Set-Content -LiteralPath $StatusPath -Value 'stopped' -Encoding ascii
exit $child.ExitCode
