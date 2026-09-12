$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('vast-startup-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$compiler = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Filter makensis.exe -Recurse | Select-Object -First 1
if (-not $compiler) { throw 'NSIS compiler is required.' }
$helper = Join-Path $repo 'resources\apply-update.ps1'
$browser = Join-Path $root 'Vast fixture.exe'
$installer = Join-Path $root 'setup.exe'
$installed = Join-Path $root 'installed.txt'
$opened = Join-Path $root 'opened.txt'
$recordPath = Join-Path $root 'pending.json'
$argsPath = Join-Path $root 'args.json'
$readyPath = Join-Path $root 'ready.txt'
$parent = $null
function Build-Fixture([string]$Exe, [string]$Body) {
  $text = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include FileFunc.nsh
Name "Vast isolated handoff fixture"
OutFile "OUTPUT"
Section
BODY
SectionEnd
'@
  $text = $text.Replace('OUTPUT',$Exe).Replace('BODY',$Body)
  Set-Content -LiteralPath ($Exe + '.nsi') -Value $text -Encoding UTF8
  & $compiler.FullName /V2 ($Exe + '.nsi')
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile fixture.' }
}
function Invoke-Handoff([string]$ExpectedHash, [int]$ParentId) {
  @{version='9999.0.0';executable=$browser;installer=$installer;sha512=$ExpectedHash;attempts=0;automatic=$true} | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
  $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $helper + '"'),'-RecordPath',('"' + $recordPath + '"'),'-LaunchPath',('"' + $browser + '"'),'-ArgumentsPath',('"' + $argsPath + '"'),'-ParentProcessId',([string]$ParentId))
  $arguments += '-Handshake'
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $readyPath
}
function Wait-Opened {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $opened) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $opened)) { throw 'Browser did not reopen after handoff.' }
  $argsText = Get-Content -LiteralPath $opened -Raw
  if (-not $argsText.Contains('--vast-after-update') -or -not $argsText.Contains('https://example.test/a?x=1&y=2')) { throw 'Launch arguments were lost.' }
}
try {
  $browserBody = '  FileOpen $0 "' + $opened + '" w' + "`n" + '  ${GetParameters} $1' + "`n" + '  FileWrite $0 $1' + "`n" + '  FileClose $0'
  $installerBody = '  FileOpen $0 "' + $installed + '" w' + "`n" + '  FileWrite $0 "installed"' + "`n" + '  FileClose $0'
  Build-Fixture $browser $browserBody
  Build-Fixture $installer $installerBody
  $hash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($installer)))
  @('https://example.test/a?x=1&y=2','--profile=path with spaces') | ConvertTo-Json | Set-Content -LiteralPath $argsPath -Encoding UTF8
  $parent = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\ping.exe') -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
  $run = Invoke-Handoff $hash $parent.Id
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ((-not (Test-Path -LiteralPath $readyPath) -or -not (Get-Content -LiteralPath $readyPath -Raw)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Get-Content -LiteralPath $readyPath -Raw).Contains('VAST_UPDATE_READY')) { throw 'Helper did not acknowledge its handoff before parent exit.' }
  if (Test-Path -LiteralPath $installed) { throw 'Installer started before its parent exited.' }
  Stop-Process -Id $parent.Id
  $parent.WaitForExit()
  $run.WaitForExit()
  Wait-Opened
  if (-not (Test-Path -LiteralPath $installed)) { throw 'Verified installer did not run.' }
  Remove-Item -LiteralPath $opened,$installed
  # Corruption must block execution and still reopen the previous browser once.
  $run = Invoke-Handoff ([Convert]::ToBase64String((New-Object byte[] 64))) $parent.Id
  $run.WaitForExit()
  Wait-Opened
  if (Test-Path -LiteralPath $installed) { throw 'Corrupt installer executed.' }
  if (-not (Get-Content -LiteralPath ($recordPath + '.error') -Raw).Contains('SHA-512')) { throw 'Missing verification failure.' }
  if ((Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json).attempts -ne 1) { throw 'Attempt count was not persisted.' }
  Remove-Item -LiteralPath $opened
  Build-Fixture $installer '  SetErrorLevel 2'
  $hash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($installer)))
  $run = Invoke-Handoff $hash $parent.Id
  $run.WaitForExit()
  Wait-Opened
  if (-not (Get-Content -LiteralPath ($recordPath + '.error') -Raw).Contains('code 2')) { throw 'Installer failure was not recorded.' }
  Write-Output 'PASS next-start handoff: readiness acknowledgement, parent wait, hash verification, installer before browser, preserved arguments, corrupt payload blocked, recovery launch without loop.'
} finally {
  if ($parent -and -not $parent.HasExited) { Stop-Process -Id $parent.Id }
  $resolved = [IO.Path]::GetFullPath($root)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'vast-startup-test-*') { throw 'Unexpected fixture cleanup path.' }
  # The reopened fixture writes its marker before Windows releases its executable.
  # Bound cleanup retries so a real leaked process still fails the test.
  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while (Test-Path -LiteralPath $resolved) {
    try {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    } catch {
      if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}
