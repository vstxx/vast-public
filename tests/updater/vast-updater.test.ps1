$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$UpdaterScript = Join-Path $RepoRoot 'release\Updater\VastUpdater.ps1'

function Assert-True {
  param(
    [bool] $Condition,
    [string] $Message
  )

  if (-not $Condition) {
    throw "Assertion failed: $Message"
  }
}

function Assert-Equal {
  param(
    [object] $Expected,
    [object] $Actual,
    [string] $Message
  )

  if ($Expected -ne $Actual) {
    throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."
  }
}

function New-TestRoot {
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-updater-test-{0}" -f ([System.Guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  return $root
}

function New-TestPayload {
  param([string] $Root)

  $payload = Join-Path $Root 'payload'
  New-Item -ItemType Directory -Path (Join-Path $payload 'resources') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $payload 'locales') -Force | Out-Null

  Set-Content -Path (Join-Path $payload 'Vast.exe') -Value 'vast-runtime-1.0.4' -Encoding UTF8
  Set-Content -Path (Join-Path $payload 'resources\app.asar') -Value 'asar-1.0.4' -Encoding UTF8
  Set-Content -Path (Join-Path $payload 'resources\version.json') -Value '{"version":"1.0.4","edition":"free"}' -Encoding UTF8
  Set-Content -Path (Join-Path $payload 'locales\en-US.pak') -Value 'locale-1.0.4' -Encoding UTF8
  Set-Content -Path (Join-Path $payload 'chrome_100_percent.pak') -Value 'pak-1.0.4' -Encoding UTF8

  return $payload
}

function New-TestInstall {
  param([string] $Root)

  $install = Join-Path $Root 'install'
  New-Item -ItemType Directory -Path (Join-Path $install 'resources') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $install 'profiles') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $install 'notes') -Force | Out-Null

  Set-Content -Path (Join-Path $install 'Vast.exe') -Value 'vast-runtime-1.0.3' -Encoding UTF8
  Set-Content -Path (Join-Path $install 'resources\app.asar') -Value 'asar-1.0.3' -Encoding UTF8
  Set-Content -Path (Join-Path $install 'version.json') -Value '{"version":"1.0.3"}' -Encoding UTF8
  Set-Content -Path (Join-Path $install 'profiles\profile.json') -Value '{"name":"primary"}' -Encoding UTF8
  Set-Content -Path (Join-Path $install 'notes\personal.md') -Value 'keep me' -Encoding UTF8

  return $install
}

function New-TestUserData {
  param([string] $Root)

  $userData = Join-Path $Root 'user-data'
  New-Item -ItemType Directory -Path (Join-Path $userData 'Bookmarks') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $userData 'Local Vault') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $userData 'Sessions') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $userData 'Network') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $userData 'Partitions\vast-default\Network') -Force | Out-Null

  Set-Content -Path (Join-Path $userData 'settings.json') -Value '{"theme":"dark"}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'vast-data.json') -Value '{"schemaVersion":5,"bookmarks":[{"title":"Keep"}]}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'password-vault.json') -Value '{"schemaVersion":1,"records":[{"id":"keep"}]}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'Bookmarks\bookmarks.json') -Value '{"items":[{"title":"Vast"}]}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'Local Vault\vault.json') -Value '{"encrypted":true}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'Sessions\session.json') -Value '{"tabs":["https://example.test"]}' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'Network\Cookies') -Value 'default-cookie-db' -Encoding UTF8
  Set-Content -Path (Join-Path $userData 'Partitions\vast-default\Network\Cookies') -Value 'partition-cookie-db' -Encoding UTF8

  return $userData
}

function New-TestLegacyUserData {
  param([string] $Root)

  $legacyUserData = Join-Path $Root 'legacy-user-data'
  New-Item -ItemType Directory -Path $legacyUserData -Force | Out-Null

  Set-Content -Path (Join-Path $legacyUserData 'vast-data.json') -Value '{"schemaVersion":5,"bookmarks":[{"title":"Keep"}],"tabs":[{"url":"https://keep.example"}],"settings":{"theme":"custom"}}' -Encoding UTF8
  Set-Content -Path (Join-Path $legacyUserData 'password-vault.json') -Value '{"schemaVersion":1,"records":[{"id":"keep","encryptedPassword":"cipher"}]}' -Encoding UTF8
  Set-Content -Path (Join-Path $legacyUserData 'vast-network-devices.json') -Value '{"devices":[{"name":"router"}]}' -Encoding UTF8
  Set-Content -Path (Join-Path $legacyUserData 'Local State') -Value '{"os_crypt":{"encrypted_key":"legacy-key"}}' -Encoding UTF8
  New-Item -ItemType Directory -Path (Join-Path $legacyUserData 'Network') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $legacyUserData 'Partitions\vast-default\Network') -Force | Out-Null
  Set-Content -Path (Join-Path $legacyUserData 'Network\Cookies') -Value 'legacy-default-cookie-db' -Encoding UTF8
  Set-Content -Path (Join-Path $legacyUserData 'Partitions\vast-default\Network\Cookies') -Value 'legacy-partition-cookie-db' -Encoding UTF8

  return $legacyUserData
}

if (-not (Test-Path -LiteralPath $UpdaterScript)) {
  throw "Updater script missing: $UpdaterScript"
}

$env:VAST_UPDATER_LIBRARY_MODE = '1'
. $UpdaterScript
Remove-Item Env:\VAST_UPDATER_LIBRARY_MODE -ErrorAction SilentlyContinue

Assert-Equal -1 (Compare-VastSemVer '1.0.1' '1.0.4') '1.0.1 should sort before 1.0.4'
Assert-Equal 0 (Compare-VastSemVer '1.0.4' '1.0.4') '1.0.4 should sort equal to itself'
Assert-Equal 1 (Compare-VastSemVer '1.0.10' '1.0.4') 'semantic comparison should compare numeric parts'
Assert-Equal -1 (Compare-VastSemVer '0.1.5-beta.1' '0.1.5-beta.2') 'successive public betas should upgrade in order'
Assert-Equal -1 (Compare-VastSemVer '0.1.5-beta.2' '0.1.5') 'a beta should upgrade to the final release'
Assert-Equal 1 (Compare-VastSemVer '0.1.5' '0.1.5-beta.2') 'the final release must not downgrade to a beta'
Assert-Equal '0.1.5-beta.2' (Select-VastApplicationVersion @('0.1.5-beta.2', '42.2.0')) 'application prerelease identifiers should be preserved'
Assert-Equal '1.0.1' (Select-VastApplicationVersion @('1.0.1', '42.2.0')) 'application version should win over Electron runtime version'
Assert-Equal '' (Select-VastApplicationVersion @('42.2.0', '42.3.0')) 'Electron runtime versions should not be treated as Vast app versions'

$customDataRootTest = New-TestRoot
$previousAppData = $env:APPDATA
try {
  $appData = Join-Path $customDataRootTest 'AppData'
  $configuredRoot = Join-Path $customDataRootTest 'CustomVastData'
  New-Item -ItemType Directory -Path (Join-Path $appData 'Vast') -Force | Out-Null
  New-Item -ItemType Directory -Path $configuredRoot -Force | Out-Null
  @{ customDataRoot = $configuredRoot } | ConvertTo-Json | Set-Content -Path (Join-Path $appData 'Vast\data-root.json') -Encoding UTF8
  $env:APPDATA = $appData

  $roots = Get-VastUserDataRoots -RequestedUserDataRoot '' -Config $null
  Assert-Equal $configuredRoot $roots[0] 'updater should detect configured custom Vast data root first'
} finally {
  if ($null -eq $previousAppData) {
    Remove-Item Env:\APPDATA -ErrorAction SilentlyContinue
  } else {
    $env:APPDATA = $previousAppData
  }
  Remove-Item -LiteralPath $customDataRootTest -Recurse -Force -ErrorAction SilentlyContinue
}

$registryRoot = New-TestRoot
$registryKey = "HKCU:\Software\VastUpdaterTests\Uninstall\$([System.Guid]::NewGuid().ToString('N'))"
try {
  $install = New-TestInstall -Root $registryRoot
  New-Item -Path $registryKey -Force | Out-Null
  New-ItemProperty -Path $registryKey -Name 'DisplayName' -Value 'Vast 1.0.3' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryKey -Name 'DisplayVersion' -Value '1.0.3' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryKey -Name 'DisplayIcon' -Value "`"$install\Vast.exe`",0" -PropertyType String -Force | Out-Null

  Assert-Equal 1 (Update-VastRegistryMetadata -InstallPath $install -TargetVersion '1.0.4' -RegistryRoots @('HKCU:\Software\VastUpdaterTests\Uninstall\*')) 'updater should update matching registry metadata'
  $updatedRegistryItem = Get-ItemProperty -LiteralPath $registryKey
  Assert-Equal 'Vast 1.0.4' $updatedRegistryItem.DisplayName 'registry display name should match target version'
  Assert-Equal '1.0.4' $updatedRegistryItem.DisplayVersion 'registry display version should match target version'
  Assert-Equal $install $updatedRegistryItem.InstallLocation 'registry install location should be repaired'
} finally {
  Remove-Item -LiteralPath $registryKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath 'HKCU:\Software\VastUpdaterTests' -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $registryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$root = New-TestRoot
try {
  $payload = New-TestPayload -Root $root
  $install = New-TestInstall -Root $root
  $userData = New-TestUserData -Root $root
  $logPath = Join-Path $root 'updater.log'

  Assert-Equal '1.0.3' (Get-VastInstalledVersion -InstallPath $install) 'installed version should be read from version.json'

  $result = Invoke-VastUpdate `
    -InstallPath $install `
    -PayloadPath $payload `
    -UserDataRoot $userData `
    -LogPath $logPath `
    -TargetVersion '1.0.4' `
    -TargetEdition 'free' `
    -NonInteractive

  Assert-Equal 'Updated' $result.Status 'update should report Updated'
  Assert-Equal '1.0.4' (Get-VastInstalledVersion -InstallPath $install) 'installed version should be updated'
  Assert-Equal 'vast-runtime-1.0.4' ((Get-Content -Raw -Path (Join-Path $install 'Vast.exe')).Trim()) 'runtime executable should be replaced'
  Assert-Equal 'asar-1.0.4' ((Get-Content -Raw -Path (Join-Path $install 'resources\app.asar')).Trim()) 'app archive should be replaced'
  Assert-Equal '{"name":"primary"}' ((Get-Content -Raw -Path (Join-Path $install 'profiles\profile.json')).Trim()) 'install-local profiles should be preserved'
  Assert-Equal 'keep me' ((Get-Content -Raw -Path (Join-Path $install 'notes\personal.md')).Trim()) 'install-local notes should be preserved'
  Assert-Equal '{"schemaVersion":5,"bookmarks":[{"title":"Keep"}]}' ((Get-Content -Raw -Path (Join-Path $userData 'vast-data.json')).Trim()) 'main Vast data file should be preserved'
  Assert-Equal '{"schemaVersion":1,"records":[{"id":"keep"}]}' ((Get-Content -Raw -Path (Join-Path $userData 'password-vault.json')).Trim()) 'password vault file should be preserved'
  Assert-Equal '{"theme":"dark"}' ((Get-Content -Raw -Path (Join-Path $userData 'settings.json')).Trim()) 'settings should be preserved'
  Assert-Equal '{"encrypted":true}' ((Get-Content -Raw -Path (Join-Path $userData 'Local Vault\vault.json')).Trim()) 'vault data should be preserved'
  Assert-True (Test-Path -LiteralPath $logPath) 'updater should write a readable log'
  Assert-True ((Get-Content -Raw -Path $logPath) -match 'Update completed successfully') 'log should record success'
  Assert-True (@(Get-ChildItem -Directory -Path (Join-Path $userData 'Backups')).Count -ge 1) 'critical user data backup should be created'
  Assert-Equal 'default-cookie-db' ((Get-Content -Raw -Path (Join-Path $result.BackupPath 'user-data-1\Network\Cookies')).Trim()) 'default-session cookies should be backed up'
  Assert-Equal 'partition-cookie-db' ((Get-Content -Raw -Path (Join-Path $result.BackupPath 'user-data-1\Partitions\vast-default\Network\Cookies')).Trim()) 'partition cookies should be backed up'
  Assert-True (-not ($result.PSObject.Properties.Name -contains 'TargetEdition')) 'legacy target edition input must not affect updater results'
  Assert-True (-not ((Get-Content -Raw -Path (Join-Path $install 'version.json')) -match 'edition')) 'new installed version metadata must not generate edition'

  Set-Content -Path (Join-Path $payload 'resources\app.asar') -Value 'asar-1.0.4-repaired' -Encoding UTF8
  $repairSameVersion = Invoke-VastUpdate `
    -InstallPath $install `
    -PayloadPath $payload `
    -UserDataRoot $userData `
    -LogPath $logPath `
    -TargetVersion '1.0.4' `
    -NonInteractive

  Assert-Equal 'Repaired' $repairSameVersion.Status 'same-version update should repair changed runtime files'
  Assert-Equal 'asar-1.0.4-repaired' ((Get-Content -Raw -Path (Join-Path $install 'resources\app.asar')).Trim()) 'same-version repair should replace changed runtime file'

  $alreadyCurrent = Invoke-VastUpdate `
    -InstallPath $install `
    -PayloadPath $payload `
    -UserDataRoot $userData `
    -LogPath $logPath `
    -TargetVersion '1.0.4' `
    -NonInteractive

  Assert-Equal 'AlreadyCurrent' $alreadyCurrent.Status 'second update should detect current version'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

$migrationRoot = New-TestRoot
$previousMigrationAppData = $env:APPDATA
$previousMigrationLocalAppData = $env:LOCALAPPDATA
try {
  $env:APPDATA = Join-Path $migrationRoot 'isolated-appdata'
  $env:LOCALAPPDATA = Join-Path $migrationRoot 'isolated-localappdata'
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA -Force | Out-Null
  $payload = New-TestPayload -Root $migrationRoot
  $install = New-TestInstall -Root $migrationRoot
  $newUserData = Join-Path $migrationRoot 'new-user-data'
  $legacyUserData = New-TestLegacyUserData -Root $migrationRoot
  $logPath = Join-Path $migrationRoot 'migration.log'
  $configPath = Join-Path $migrationRoot 'updater.config.json'
  New-Item -ItemType Directory -Path $newUserData -Force | Out-Null
  Set-Content -Path (Join-Path $newUserData 'vast-data.json') -Value '{"schemaVersion":5,"bookmarks":[],"tabs":[],"settings":{"theme":"default"}}' -Encoding UTF8
  Set-Content -Path (Join-Path $newUserData 'password-vault.json') -Value '{"schemaVersion":1,"records":[]}' -Encoding UTF8
  Set-Content -Path (Join-Path $newUserData 'Local State') -Value '{"os_crypt":{"encrypted_key":"new-default-key"}}' -Encoding UTF8
  @{
    targetVersion = '1.0.4'
    targetEdition = 'free'
    edition = 'free'
    payloadPath = $payload
    installPaths = @($install)
    userDataPaths = @($newUserData, $legacyUserData)
    processNames = @('DefinitelyNotVast')
    criticalUserDataItems = @('vast-data.json', 'password-vault.json', 'vast-network-devices.json', 'Local State', 'Network', 'Partitions')
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

  Invoke-VastUpdate `
    -ConfigPath $configPath `
    -LogPath $logPath `
    -TargetVersion '1.0.4' `
    -NonInteractive | Out-Null

  Assert-Equal ((Get-Content -Raw -Path (Join-Path $legacyUserData 'vast-data.json')).Trim()) ((Get-Content -Raw -Path (Join-Path $newUserData 'vast-data.json')).Trim()) 'legacy main data should migrate to canonical user data root'
  Assert-Equal ((Get-Content -Raw -Path (Join-Path $legacyUserData 'password-vault.json')).Trim()) ((Get-Content -Raw -Path (Join-Path $newUserData 'password-vault.json')).Trim()) 'legacy password vault should migrate to canonical user data root'
  Assert-Equal ((Get-Content -Raw -Path (Join-Path $legacyUserData 'Local State')).Trim()) ((Get-Content -Raw -Path (Join-Path $newUserData 'Local State')).Trim()) 'legacy Local State should migrate with password vault so safeStorage can decrypt'
  Assert-Equal ((Get-Content -Raw -Path (Join-Path $legacyUserData 'vast-network-devices.json')).Trim()) ((Get-Content -Raw -Path (Join-Path $newUserData 'vast-network-devices.json')).Trim()) 'legacy network devices should migrate to canonical user data root'
  Assert-Equal 'legacy-default-cookie-db' ((Get-Content -Raw -Path (Join-Path $newUserData 'Network\Cookies')).Trim()) 'legacy default-session cookies should migrate to canonical user data root'
  Assert-Equal 'legacy-partition-cookie-db' ((Get-Content -Raw -Path (Join-Path $newUserData 'Partitions\vast-default\Network\Cookies')).Trim()) 'legacy partition cookies should migrate to canonical user data root'
} finally {
  if ($null -eq $previousMigrationAppData) { Remove-Item Env:\APPDATA -ErrorAction SilentlyContinue } else { $env:APPDATA = $previousMigrationAppData }
  if ($null -eq $previousMigrationLocalAppData) { Remove-Item Env:\LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $previousMigrationLocalAppData }
  Remove-Item -LiteralPath $migrationRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$lockRoot = New-TestRoot
try {
  $payload = New-TestPayload -Root $lockRoot
  $install = New-TestInstall -Root $lockRoot
  $userData = New-TestUserData -Root $lockRoot
  $logPath = Join-Path $lockRoot 'locked.log'
  $lockedFile = Join-Path $install 'Vast.exe'
  $stream = [System.IO.File]::Open($lockedFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $failed = $false
    try {
      Invoke-VastUpdate `
        -InstallPath $install `
        -PayloadPath $payload `
        -UserDataRoot $userData `
        -LogPath $logPath `
        -TargetVersion '1.0.4' `
        -NonInteractive | Out-Null
    } catch {
      $failed = $true
    }

    Assert-True $failed 'locked runtime file should make update fail safely'
    Assert-Equal '{"version":"1.0.3"}' ((Get-Content -Raw -Path (Join-Path $install 'version.json')).Trim()) 'locked-file failure should leave installed version unchanged'
  } finally {
    $stream.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $lockRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$dryRunRoot = New-TestRoot
try {
  $payload = New-TestPayload -Root $dryRunRoot
  $install = New-TestInstall -Root $dryRunRoot
  $userData = New-TestUserData -Root $dryRunRoot
  $logPath = Join-Path $dryRunRoot 'dry-run.log'
  $beforeExe = (Get-Content -Raw -LiteralPath (Join-Path $install 'Vast.exe')).Trim()
  $beforeData = (Get-Content -Raw -LiteralPath (Join-Path $userData 'vast-data.json')).Trim()

  $result = Invoke-VastUpdate -InstallPath $install -PayloadPath $payload -UserDataRoot $userData -LogPath $logPath -TargetVersion '1.0.4' -NonInteractive -DryRun

  Assert-Equal 'DryRun' $result.Status 'dry run should report its non-mutating mode'
  Assert-Equal $beforeExe ((Get-Content -Raw -LiteralPath (Join-Path $install 'Vast.exe')).Trim()) 'dry run should not modify runtime files'
  Assert-Equal $beforeData ((Get-Content -Raw -LiteralPath (Join-Path $userData 'vast-data.json')).Trim()) 'dry run should not modify user data'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $install '.vast-update'))) 'dry run should not create a runtime transaction folder'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $userData 'Backups'))) 'dry run should not create user-data backups'
} finally {
  Remove-Item -LiteralPath $dryRunRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$validationRoot = New-TestRoot
try {
  $payload = New-TestPayload -Root $validationRoot
  $install = New-TestInstall -Root $validationRoot
  $userData = New-TestUserData -Root $validationRoot
  $logPath = Join-Path $validationRoot 'validation.log'

  $downgradeFailed = $false
  try {
    Invoke-VastUpdate -InstallPath $install -PayloadPath $payload -UserDataRoot $userData -LogPath $logPath -TargetVersion '1.0.2' -NonInteractive | Out-Null
  } catch { $downgradeFailed = $true }
  Assert-True $downgradeFailed 'updater should reject a downgrade or mismatched payload before writing files'
  Assert-Equal 'vast-runtime-1.0.3' ((Get-Content -Raw -LiteralPath (Join-Path $install 'Vast.exe')).Trim()) 'rejected downgrade should not modify the runtime'

  Remove-Item -LiteralPath (Join-Path $payload 'resources\app.asar') -Force
  $incompleteFailed = $false
  try { Test-VastPayload -PayloadPath $payload -ExpectedVersion '1.0.4' } catch { $incompleteFailed = $true }
  Assert-True $incompleteFailed 'incomplete update payload should fail validation'
} finally {
  Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$rollbackRoot = New-TestRoot
try {
  $payload = New-TestPayload -Root $rollbackRoot
  $install = New-TestInstall -Root $rollbackRoot
  $userData = New-TestUserData -Root $rollbackRoot
  $logPath = Join-Path $rollbackRoot 'rollback.log'
  Set-Content -LiteralPath (Join-Path $install 'locales') -Value 'parent-path-collision' -Encoding UTF8

  $rollbackFailed = $false
  try {
    Invoke-VastUpdate -InstallPath $install -PayloadPath $payload -UserDataRoot $userData -LogPath $logPath -TargetVersion '1.0.4' -NonInteractive | Out-Null
  } catch { $rollbackFailed = $true }
  Assert-True $rollbackFailed 'mid-copy failure should fail the update'
  Assert-Equal 'vast-runtime-1.0.3' ((Get-Content -Raw -LiteralPath (Join-Path $install 'Vast.exe')).Trim()) 'rollback should restore an already replaced executable'
  Assert-Equal 'asar-1.0.3' ((Get-Content -Raw -LiteralPath (Join-Path $install 'resources\app.asar')).Trim()) 'rollback should preserve the old application archive'
  Assert-Equal '{"version":"1.0.3"}' ((Get-Content -Raw -LiteralPath (Join-Path $install 'version.json')).Trim()) 'rollback should preserve the installed version'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $install 'chrome_100_percent.pak'))) 'rollback should remove newly introduced runtime files'
  Assert-True ((Get-Content -Raw -LiteralPath $logPath) -match 'Rolling back application runtime changes') 'rollback should be recorded in the updater log'
} finally {
  Remove-Item -LiteralPath $rollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$backupFailureRoot = New-TestRoot
try {
  $payload = New-TestPayload -Root $backupFailureRoot
  $install = New-TestInstall -Root $backupFailureRoot
  $userData = New-TestUserData -Root $backupFailureRoot
  $logPath = Join-Path $backupFailureRoot 'backup-failure.log'
  $criticalFile = Join-Path $userData 'vast-data.json'
  $stream = [System.IO.File]::Open($criticalFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $backupFailed = $false
    try {
      Invoke-VastUpdate -InstallPath $install -PayloadPath $payload -UserDataRoot $userData -LogPath $logPath -TargetVersion '1.0.4' -NonInteractive | Out-Null
    } catch { $backupFailed = $true }
    Assert-True $backupFailed 'failure to back up critical user data should abort the update'
    Assert-Equal 'vast-runtime-1.0.3' ((Get-Content -Raw -LiteralPath (Join-Path $install 'Vast.exe')).Trim()) 'backup failure should abort before runtime replacement'
  } finally {
    $stream.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $backupFailureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Vast updater tests passed.'
