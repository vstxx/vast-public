#Requires -RunAsAdministrator

param([switch] $KeepInstallers)

. (Join-Path $PSScriptRoot 'common.ps1')

function Get-MicrosoftInstaller([string] $Uri, [string] $Destination) {
  Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
  $signature = Get-AuthenticodeSignature -LiteralPath $Destination
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "Installer signature validation failed: $Destination ($($signature.Status))"
  }
}

$vsInstaller = Join-Path $env:TEMP 'vast-vs-community-2026.exe'
$sdkInstaller = Join-Path $env:TEMP 'vast-winsdksetup-10.0.26100.7705.exe'
try {
  if (-not (Find-VastVisualStudio2026)) {
    Get-MicrosoftInstaller 'https://aka.ms/vs/stable/vs_community.exe' $vsInstaller
    # Start-Process joins argument arrays without preserving quotes around values
    # containing spaces. Keep this as one explicitly quoted command line.
    $vsArguments = '--installPath "C:\Program Files\Microsoft Visual Studio\18\Community" --add Microsoft.VisualStudio.Workload.NativeDesktop --add Microsoft.VisualStudio.Component.VC.ATLMFC --includeRecommended --passive --wait --norestart'
    $process = Start-Process -FilePath $vsInstaller -ArgumentList $vsArguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw "Visual Studio installer failed with exit code $($process.ExitCode)." }
  }

  $cdb = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
  if (-not (Test-Path -LiteralPath $cdb -PathType Leaf)) {
    Get-MicrosoftInstaller 'https://download.microsoft.com/download/f4b30f2a-4fc3-430e-9b03-c842b5f5f9f1/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe' $sdkInstaller
    $process = Start-Process -FilePath $sdkInstaller -ArgumentList '/features OptionId.WindowsDesktopDebuggers /quiet /norestart' -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw "Windows SDK installer failed with exit code $($process.ExitCode)." }
  }

  if (-not (Find-VastVisualStudio2026)) { throw 'Visual Studio 2026 C++/ATL/MFC verification failed after installation.' }
  if (-not (Test-Path -LiteralPath $cdb -PathType Leaf)) { throw 'SDK Debugging Tools verification failed after installation.' }
  Write-Host 'Chromium Windows prerequisites are installed and verified.'
} finally {
  if (-not $KeepInstallers) {
    Remove-Item -LiteralPath $vsInstaller, $sdkInstaller -Force -ErrorAction SilentlyContinue
  }
}
