$ErrorActionPreference = 'Stop'
$env:VAST_UPDATER_LIBRARY_MODE = '1'
. (Join-Path $PSScriptRoot '..\..\resources\updater\VastUpdater.ps1')
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('vast-alpha-channel-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  Write-VastInstalledVersionFile -InstallPath $root -TargetVersion '0.5.0-alpha.1' -TargetChannel 'alpha'
  $version = Get-Content -Raw -LiteralPath (Join-Path $root 'version.json') | ConvertFrom-Json
  if ($version.version -ne '0.5.0-alpha.1' -or $version.channel -ne 'alpha') {
    throw 'The updater did not retain the local alpha identity.'
  }
  $profile = Join-Path $root 'profile'
  $install = Join-Path $root 'install'
  $backupParent = Join-Path $root 'backups'
  New-Item -ItemType Directory -Path (Join-Path $profile 'Extensions') -Force | Out-Null
  New-Item -ItemType Directory -Path $install -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $profile 'Extensions\registry.json') -Value '{"installed":true}'
  $backup = Backup-VastUserData -InstallPath $install -UserDataRoots @($profile) -Config $null -TargetVersion '0.5.0-alpha.1' -BackupRootPath $backupParent
  if (-not (Test-Path -LiteralPath (Join-Path $backup 'user-data-1\Extensions\registry.json'))) {
    throw 'The updater did not back up managed extensions from the daily profile.'
  }
  Write-Host 'Local alpha updater channel test passed.'
} finally {
  Remove-Item Env:VAST_UPDATER_LIBRARY_MODE -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
