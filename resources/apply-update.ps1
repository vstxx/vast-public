param([Parameter(Mandatory=$true)][string] $RecordPath, [Parameter(Mandatory=$true)][string] $LaunchPath, [Parameter(Mandatory=$true)][string] $ArgumentsPath, [int] $ParentProcessId, [switch] $Handshake)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
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
  if ($Handshake) { [Console]::Out.WriteLine('VAST_UPDATE_READY'); [Console]::Out.Flush() }
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
if ($Handshake -and (-not $accepted -or -not $parentClosed)) { exit 1 }
# Never loop automatically after a failed installer; the old browser remains usable.
function Quote-Argument([string] $Value) {
  '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
$arguments = @($launchArgs | Where-Object { $_ -ne '--vast-after-update' } | ForEach-Object { Quote-Argument ([string]$_) })
$arguments += '--vast-after-update'
Start-Process -FilePath $LaunchPath -ArgumentList ($arguments -join ' ') -WorkingDirectory ([IO.Path]::GetDirectoryName($LaunchPath)) -WindowStyle Hidden
