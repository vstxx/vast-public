[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CredentialHashPath,

  [ValidateRange(1024, 65535)]
  [int]$Port = 54446
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$BackgroundRoot = Join-Path $Root '.vast-build\password-manager-gates\background\fixture'
$HashRoot = [IO.Path]::GetFullPath((Join-Path $Root '.vast-build\password-manager-gates\credential-hashes'))
$ResolvedHashPath = [IO.Path]::GetFullPath($CredentialHashPath)
$TlsRoot = Join-Path $Root '.vast-build\password-manager-gates\tls'
$Runner = Join-Path $PSScriptRoot 'run-fixture-server.cjs'
$LauncherPath = Join-Path $BackgroundRoot 'launcher.json'
$ReadyPath = Join-Path $BackgroundRoot 'ready.json'
$StatusPath = Join-Path $BackgroundRoot 'status'
$ExitCodePath = Join-Path $BackgroundRoot 'exit-code'
$LogPath = Join-Path $BackgroundRoot 'process.log'
$ErrorLogPath = Join-Path $BackgroundRoot 'process-error.log'

$HashRootPrefix = $HashRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $ResolvedHashPath.StartsWith($HashRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Credential hash record must be inside the gate credential-hashes directory.'
}
if (-not (Test-Path -LiteralPath $ResolvedHashPath -PathType Leaf)) { throw 'Credential hash record does not exist.' }
if (-not (Test-Path -LiteralPath $Runner -PathType Leaf)) { throw 'Fixture server runner is missing.' }

New-Item -ItemType Directory -Force -Path $BackgroundRoot | Out-Null
if (Test-Path -LiteralPath $LauncherPath) {
  try {
    $existing = Get-Content -Raw -LiteralPath $LauncherPath | ConvertFrom-Json
    if ($existing.wrapperPid -and (Get-Process -Id $existing.wrapperPid -ErrorAction SilentlyContinue)) {
      throw "A fixture server launcher is already running as PID $($existing.wrapperPid)."
    }
  } catch {
    if ($_.Exception.Message -like 'A fixture server launcher*') { throw }
  }
}

Remove-Item -LiteralPath $ReadyPath,$ExitCodePath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $StatusPath -Value 'starting' -Encoding ascii
$child = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @(
    ('"' + $Runner + '"'),
    '--credential-hashes', ('"' + $ResolvedHashPath + '"'),
    '--tls-root', ('"' + $TlsRoot + '"'),
    '--ready-file', ('"' + $ReadyPath + '"'),
    '--port', "$Port"
  ) `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $LogPath `
  -RedirectStandardError $ErrorLogPath `
  -WindowStyle Hidden `
  -PassThru

[ordered]@{
  schemaVersion = 1
  wrapperPid = $PID
  serverPid = $child.Id
  port = $Port
  credentialHashFile = [IO.Path]::GetFileName($ResolvedHashPath)
  startedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $LauncherPath -Encoding utf8

$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not (Test-Path -LiteralPath $ReadyPath) -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $ReadyPath)) {
  if (-not $child.HasExited) { $child.Kill() }
  Set-Content -LiteralPath $StatusPath -Value 'failed' -Encoding ascii
  throw 'Fixture server did not become ready within 15 seconds.'
}
Set-Content -LiteralPath $StatusPath -Value 'running' -Encoding ascii

$child.WaitForExit()
$child.ExitCode | Set-Content -LiteralPath $ExitCodePath -Encoding ascii
Set-Content -LiteralPath $StatusPath -Value 'stopped' -Encoding ascii
exit $child.ExitCode
