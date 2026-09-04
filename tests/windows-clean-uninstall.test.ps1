param(
  [Parameter(Mandatory = $true)]
  [string] $InstallerPath,
  [string] $ExpectedSignerSubject = $env:VAST_EXPECTED_SIGNER_SUBJECT
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$explicitUnsignedRelease =
  $env:VAST_PUBLIC_UNSIGNED_RELEASE -eq '1' -and
  $env:VAST_UNSIGNED_RELEASE_ACK -eq 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'

if (-not $env:CI -and $env:VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E -ne 'YES') {
  throw 'The install/uninstall E2E mutates current-user installer registration. Run on an isolated CI user, or set VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E=YES explicitly.'
}

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Get-RegSnapshot([string] $Key) {
  $providerKey = $Key.Replace('HKCU\', 'HKEY_CURRENT_USER\').Replace('HKLM\', 'HKEY_LOCAL_MACHINE\')
  if (-not (Test-Path -LiteralPath "Registry::$providerKey")) { return '<absent>' }
  $output = & reg.exe query $Key /s 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Could not snapshot registry key: $Key" }
  return (($output | ForEach-Object { [string] $_ }) -join "`n").Trim()
}

function Test-RegistryKey([string] $Path) {
  return Test-Path -LiteralPath "Registry::$Path"
}

function Test-RegistryValue([string] $Key, [string] $Name) {
  $providerKey = $Key.Replace('HKCU\', 'HKEY_CURRENT_USER\').Replace('HKLM\', 'HKEY_LOCAL_MACHINE\')
  try {
    $registryKey = Get-Item -LiteralPath "Registry::$providerKey" -ErrorAction Stop
    return @($registryKey.GetValueNames()) -contains $Name
  } catch {
    return $false
  }
}

function Get-RegisteredApplicationValue {
  try {
    return [string](Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\RegisteredApplications' -Name 'Vast' -ErrorAction Stop)
  } catch {
    return $null
  }
}

function Get-VastUninstallEntries([string] $InstallRoot) {
  $roots = @(
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $matches = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
      $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if (-not $properties) { continue }
      $isVast = [string]$properties.DisplayName -like 'Vast*'
      $pointsAtTestInstall = @($properties.InstallLocation, $properties.UninstallString, $properties.DisplayIcon) |
        Where-Object { $_ -and ([string]$_).IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
      if ($isVast -and $pointsAtTestInstall.Count -gt 0) { $matches += $key.PSPath }
    }
  }
  return @($matches)
}

$protectedRegistryKeys = @(
  'HKCU\Software\Classes\http',
  'HKCU\Software\Classes\https',
  'HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice',
  'HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
)
$protectedBefore = @{}
foreach ($key in $protectedRegistryKeys) { $protectedBefore[$key] = Get-RegSnapshot $key }

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-store-uninstall-{0}" -f [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'installed'
$profileRoot = Join-Path $testRoot 'profile'
$artifactsRoot = Join-Path $testRoot 'artifacts'
New-Item -ItemType Directory -Path $testRoot, $profileRoot, $artifactsRoot -Force | Out-Null

try {
  $installerSignature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
  $expectedSignatureStatus = $(if ($explicitUnsignedRelease) { 'NotSigned' } else { 'Valid' })
  Assert-True ([string]$installerSignature.Status -eq $expectedSignatureStatus) "installer Authenticode trust must be $expectedSignatureStatus"
  if (-not $explicitUnsignedRelease -and -not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    Assert-True ([string]$installerSignature.SignerCertificate.Subject -like "*$ExpectedSignerSubject*") "installer signer must contain '$ExpectedSignerSubject'"
  }

  $install = Start-Process -FilePath $resolvedInstaller -ArgumentList @('/currentuser', '/S', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
  Assert-True ($install.ExitCode -eq 0) "silent installer exited with $($install.ExitCode)"
  $vastExe = Join-Path $installRoot 'Vast.exe'
  Assert-True (Test-Path -LiteralPath $vastExe -PathType Leaf) 'installed Vast.exe must exist'

  $previousProfile = $env:VAST_TEST_USER_DATA_DIR
  try {
    $env:VAST_TEST_USER_DATA_DIR = $profileRoot
    & node (Join-Path $repoRoot 'scripts\register-default-browser-e2e.cjs') $vastExe
    Assert-True ($LASTEXITCODE -eq 0) 'installed Vast must launch and register with Windows Default Apps'
  } finally {
    $env:VAST_TEST_USER_DATA_DIR = $previousProfile
  }

  Assert-True ((Get-RegisteredApplicationValue) -eq 'Software\Clients\StartMenuInternet\Vast\Capabilities') 'RegisteredApplications must advertise Vast capabilities'
  Assert-True (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Clients\StartMenuInternet\Vast') 'Vast StartMenuInternet registration must exist'
  Assert-True (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Classes\VastHTML') 'Vast URL ProgID must exist'
  Assert-True (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Classes\VastPDF') 'Vast PDF ProgID must exist'
  Assert-True (Test-RegistryValue 'HKCU\Software\Classes\.pdf\OpenWithProgids' 'VastPDF') 'Vast must be available in Open with for PDF files'
  Assert-True ((Get-VastUninstallEntries $installRoot).Count -gt 0) 'the installed product must have a scoped uninstall entry'

  $peReportPath = Join-Path $artifactsRoot 'installed-pe-signatures.json'
  if ($explicitUnsignedRelease) {
    $peOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\verify-all-pe-signatures.ps1') -Root $installRoot -ReportOnly
    Assert-True ($LASTEXITCODE -eq 0) 'every PE in the installed unsigned runtime must be recursively inventoried'
  } else {
    $peOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\verify-all-pe-signatures.ps1') -Root $installRoot
    Assert-True ($LASTEXITCODE -eq 0) 'every PE in the installed runtime must have Valid Authenticode trust'
  }
  $peOutput | Set-Content -LiteralPath $peReportPath -Encoding UTF8

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -File -Filter 'Uninstall*.exe' | Select-Object -First 1
  Assert-True ($null -ne $uninstaller) 'installed uninstaller must exist'
  $uninstallerSignature = Get-AuthenticodeSignature -LiteralPath $uninstaller.FullName
  Assert-True ([string]$uninstallerSignature.Status -eq $expectedSignatureStatus) "uninstaller Authenticode trust must be $expectedSignatureStatus"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  Assert-True ($uninstall.ExitCode -eq 0) "silent uninstaller exited with $($uninstall.ExitCode)"

  for ($attempt = 0; $attempt -lt 40 -and (Test-Path -LiteralPath $installRoot); $attempt += 1) { Start-Sleep -Milliseconds 250 }
  Assert-True (-not (Test-Path -LiteralPath $installRoot)) 'uninstall must remove every installer-owned runtime file'
  Assert-True ($null -eq (Get-RegisteredApplicationValue)) 'uninstall must remove Vast from RegisteredApplications'
  Assert-True (-not (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Clients\StartMenuInternet\Vast')) 'uninstall must remove the Vast StartMenuInternet tree'
  Assert-True (-not (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Classes\VastHTML')) 'uninstall must remove the Vast URL ProgID'
  Assert-True (-not (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Classes\VastPDF')) 'uninstall must remove the Vast PDF ProgID'
  Assert-True (-not (Test-RegistryValue 'HKCU\Software\Classes\.pdf\OpenWithProgids' 'VastPDF')) 'uninstall must remove only the Vast PDF Open with value'
  Assert-True (-not (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Classes\Applications\Vast.exe')) 'uninstall must remove the Vast application registration'
  Assert-True (-not (Test-RegistryKey 'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Vast.exe')) 'uninstall must remove the Vast App Paths registration'
  Assert-True ((Get-VastUninstallEntries $installRoot).Count -eq 0) 'uninstall must remove the product uninstall entry'

  $shortcutCandidates = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Vast.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Vast.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Vast\Vast.lnk')
  )
  foreach ($shortcut in $shortcutCandidates) {
    Assert-True (-not (Test-Path -LiteralPath $shortcut)) "uninstall must remove installer-owned shortcut: $shortcut"
  }

  foreach ($key in $protectedRegistryKeys) {
    Assert-True ((Get-RegSnapshot $key) -ceq $protectedBefore[$key]) "uninstall flow must not alter protected registry state: $key"
  }

  # The isolated profile is user-created data, not an installer-owned orphan.
  # It is intentionally retained by the product uninstaller and removed only by this harness.
  Assert-True (Test-Path -LiteralPath $profileRoot -PathType Container) 'uninstall must not silently delete user profile data'
  [ordered]@{
    ok = $true
    installer = $resolvedInstaller
    installedPeReport = $peReportPath
    protectedRegistryKeys = $protectedRegistryKeys
    profilePreservedByUninstaller = $true
  } | ConvertTo-Json -Depth 4
} finally {
  # A failed assertion after installation must not poison the isolated runner
  # or a later retry. This cleanup remains scoped to the unique temporary
  # install root and never touches generic protocol/UserChoice state itself.
  if (Test-Path -LiteralPath $installRoot) {
    $fallbackUninstaller = Get-ChildItem -LiteralPath $installRoot -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fallbackUninstaller) {
      try {
        Start-Process -FilePath $fallbackUninstaller.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
      } catch {}
    }
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
