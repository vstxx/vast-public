$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('vast-install-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$compiler = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Filter makensis.exe -Recurse | Select-Object -First 1
$plugin = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Filter nsProcess.dll -Recurse | Where-Object { $_.DirectoryName -like '*x86-unicode' } | Select-Object -First 1
if (-not $compiler -or -not $plugin) { throw 'Build the Windows package once to provision the NSIS compiler/plugins.' }
$processName = 'VastUpdateGuardFixture.exe'
$marker = Join-Path $root 'installation-touched.txt'
$registryKey = 'Software\VastUpdateGuardTest-' + [guid]::NewGuid().ToString('N')
$script = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!addplugindir "PLUGIN_PATH"
!include "PROCESS_INCLUDE"
!define APP_EXECUTABLE_FILENAME "VastUpdateGuardFixture.exe"
!define INSTALL_REGISTRY_KEY "TEST_REGISTRY_PATH"
!include "GUARD_INCLUDE"
Name "Vast isolated update guard test"
OutFile "OUTPUT_PATH"
Section
  StrCpy $INSTDIR "INSTALL_PATH"
  !insertmacro customCheckAppRunning
  FileOpen $0 "MARKER_PATH" w
  FileWrite $0 "Only reached after browser processes exited."
  FileClose $0
SectionEnd
'@
$exe = Join-Path $root 'guard.exe'
$script = $script.Replace('PLUGIN_PATH',$plugin.DirectoryName).Replace('PROCESS_INCLUDE',(Join-Path $repo 'node_modules\app-builder-lib\templates\nsis\include\nsProcess.nsh')).Replace('GUARD_INCLUDE',(Join-Path $repo 'resources\installer.nsh')).Replace('OUTPUT_PATH',$exe).Replace('MARKER_PATH',$marker)
$script = $script.Replace('TEST_REGISTRY_PATH',$registryKey).Replace('INSTALL_PATH',$root)
$fixtureProcess = $null
try {
  $scriptPath = Join-Path $root 'guard.nsi'
  Set-Content -LiteralPath $scriptPath -Value $script -Encoding UTF8
  & $compiler.FullName /V2 $scriptPath
  if ($LASTEXITCODE -ne 0) { throw 'NSIS guard did not compile.' }
  $run = Start-Process -FilePath $exe -WindowStyle Hidden -Wait -PassThru
  if ($run.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $marker)) { throw 'Idle installation should proceed.' }
  Remove-Item -LiteralPath $marker
  New-Item -Path ('HKCU:\' + $registryKey) -Force | Out-Null
  Set-ItemProperty -LiteralPath ('HKCU:\' + $registryKey) -Name InstallLocation -Value (Join-Path $root 'other installation')
  $run = Start-Process -FilePath $exe -WindowStyle Hidden -Wait -PassThru
  if ($run.ExitCode -ne 2 -or (Test-Path -LiteralPath $marker)) { throw 'Installer must not replace a different registered installation.' }
  Set-ItemProperty -LiteralPath ('HKCU:\' + $registryKey) -Name InstallLocation -Value $root
  $fixtureExe = Join-Path $root $processName
  Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\ping.exe') -Destination $fixtureExe
  $fixtureProcess = Start-Process -FilePath $fixtureExe -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
  $run = Start-Process -FilePath $exe -WindowStyle Hidden -Wait -PassThru
  $fixtureProcess.Refresh()
  if ($run.ExitCode -ne 2) { throw 'Busy installation must defer.' }
  if ($fixtureProcess.HasExited) { throw 'Installer killed the other process.' }
  if (Test-Path -LiteralPath $marker) { throw 'Installer touched files while browser was running.' }
  Stop-Process -Id $fixtureProcess.Id
  $fixtureProcess.WaitForExit()
  $run = Start-Process -FilePath $exe -WindowStyle Hidden -Wait -PassThru
  if ($run.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $marker)) { throw 'Retry after closing browser failed.' }
  Write-Output 'PASS compiled NSIS guard: idle install, registry target mismatch rejected, busy defer without process kill or file mutation, successful retry.'
} finally {
  Remove-Item -LiteralPath ('HKCU:\' + $registryKey) -Force -ErrorAction SilentlyContinue
  if ($fixtureProcess -and -not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id }
  $resolved = [IO.Path]::GetFullPath($root)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'vast-install-guard-*') { throw 'Unexpected fixture cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
