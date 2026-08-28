param(
  [string] $UpdateBaseUrl = '',
  [ValidateSet('alpha', 'beta', 'stable')]
  [string] $Channel = 'stable',
  [string] $Version = '',
  [string] $PreviousVersion = '',
  [string] $SourceCommit = $env:VAST_RELEASE_COMMIT,
  [string] $PrivateBuild = $env:VAST_PRIVATE_BUILD,
  [string] $PublicUnsignedBeta = $env:VAST_PUBLIC_UNSIGNED_BETA
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json).version
}
$SemVerPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
if ($Version -notmatch $SemVerPattern) {
  throw "Version must be valid SemVer: $Version"
}
if ([string]::IsNullOrWhiteSpace($PreviousVersion)) {
  if ($Version.Contains('-')) {
    throw 'PreviousVersion is required for a prerelease.'
  }
  $parts = @($Version.Split('.') | ForEach-Object { [int] $_ })
  if ($parts[2] -le 0) {
    throw 'PreviousVersion is required when the release patch version is zero.'
  }
  $PreviousVersion = "$($parts[0]).$($parts[1]).$($parts[2] - 1)"
}
if ($PreviousVersion -notmatch $SemVerPattern) {
  throw "PreviousVersion must be valid SemVer: $PreviousVersion"
}
$PrivateBuildEnabled = @('1', 'true', 'yes', 'on').Contains(([string] $PrivateBuild).Trim().ToLowerInvariant())
$PublicDistribution = @('beta', 'stable').Contains($Channel) -and -not $PrivateBuildEnabled
$PublicUnsignedBetaEnabled = @('1', 'true', 'yes', 'on').Contains(([string] $PublicUnsignedBeta).Trim().ToLowerInvariant())
if ($PublicUnsignedBetaEnabled -and ($Channel -ne 'beta' -or $PrivateBuildEnabled)) {
  throw 'PublicUnsignedBeta/VAST_PUBLIC_UNSIGNED_BETA is allowed only for a non-private beta distribution.'
}
if ($PublicUnsignedBetaEnabled -and $env:VAST_UNSIGNED_BETA_ACK -ne 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK') {
  throw 'Public unsigned beta preparation requires the exact risk acknowledgement.'
}
$SignaturePolicy = if ($PublicUnsignedBetaEnabled) { 'unsigned-public-beta' } elseif ($PublicDistribution) { 'authenticode-signed' } else { 'internal-unsigned' }
if ($PublicDistribution -and $SourceCommit -notmatch '^[a-fA-F0-9]{40}$') {
  throw 'A public distribution requires SourceCommit/VAST_RELEASE_COMMIT as a full Git SHA.'
}
$SourceCommit = ([string] $SourceCommit).Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($UpdateBaseUrl)) {
  $releaseRepo = if ([string]::IsNullOrWhiteSpace($env:VAST_RELEASE_REPO)) { 'vstxx/vast-public' } else { $env:VAST_RELEASE_REPO }
  $UpdateBaseUrl = "https://github.com/$releaseRepo/releases/download/v$Version/"
}
$ReleaseRoot = Join-Path $RepoRoot 'release'
$RuntimeRoot = Join-Path $ReleaseRoot "Vast-$Version"
$RuntimePayload = Join-Path $RuntimeRoot 'win-unpacked'
$UpdaterRoot = Join-Path $ReleaseRoot 'Updater'
$InstallerRoot = Join-Path $ReleaseRoot 'Installer'
$DocsRoot = Join-Path $ReleaseRoot 'Docs'
$SourceRoot = Join-Path $ReleaseRoot 'Source'
$ChecksumsRoot = Join-Path $ReleaseRoot 'Checksums'
$DownloadsRoot = Join-Path $ReleaseRoot 'Downloads'
$WinUnpacked = Join-Path $ReleaseRoot 'win-unpacked'
$UpdaterConfigFileName = 'updater.config.json'
$UpdaterConfigPath = Join-Path $UpdaterRoot $UpdaterConfigFileName
$InstallerSetupName = "Vast-Setup-$Version.exe"
$InstallerBlockmapName = "Vast-Setup-$Version.exe.blockmap"
$InstallerPortableName = "Vast-$Version-Portable.exe"
$FfmpegBuildRoot = Join-Path $RepoRoot '.vast-build\ffmpeg'
$FfmpegSourceBundle = Join-Path $FfmpegBuildRoot 'ffmpeg-corresponding-source-win64.tar.zst'
$FfmpegProvenance = Join-Path $FfmpegBuildRoot 'runtime\ffmpeg-build-provenance.json'
$FfmpegCapabilities = Join-Path $FfmpegBuildRoot 'avidae-ffmpeg-capabilities.json'

function Assert-File {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file missing: $Path"
  }
}

function Assert-Directory {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Required directory missing: $Path"
  }
}

function Reset-Directory {
  param([string] $Path)
  if (Test-Path -LiteralPath $Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
    if (-not $resolved.StartsWith($release, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside release root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function New-FileManifest {
  param(
    [string] $Root,
    [string] $OutPath,
    [string] $Product,
    [string] $Version
  )

  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
  $files = Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{
      path = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\') -replace '\\','/'
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }

  [pscustomobject]@{
    product = $Product
    version = $Version
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    files = $files
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutPath -Encoding UTF8
}

function New-VersionedUpdaterConfig {
  param(
    [string] $SourcePath,
    [string] $Version
  )

  $config = Get-Content -Raw -LiteralPath $SourcePath | ConvertFrom-Json
  $config.targetVersion = $Version
  $config.PSObject.Properties.Remove('targetEdition')
  $config.PSObject.Properties.Remove('edition')
  $config.PSObject.Properties.Remove('upgradeMode')
  $config.payloadPath = "..\Vast-$Version\win-unpacked"

  $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) "vast-updater-config-$Version.json"
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempPath -Encoding UTF8
  return $tempPath
}

Assert-Directory $WinUnpacked
Assert-File (Join-Path $ReleaseRoot "Vast-Setup-$Version.exe")
Assert-File (Join-Path $ReleaseRoot "Vast-Setup-$Version.exe.blockmap")
Assert-File (Join-Path $ReleaseRoot "Vast-$Version-Portable.exe")
Assert-File (Join-Path $ReleaseRoot 'latest.yml')
Assert-File (Join-Path $UpdaterRoot 'VastUpdater.ps1')
Assert-File $UpdaterConfigPath
Assert-File (Join-Path $UpdaterRoot "VastUpdater-$Version.exe")
Assert-File $FfmpegSourceBundle
Assert-File $FfmpegProvenance
Assert-File $FfmpegCapabilities
& node (Join-Path $RepoRoot 'scripts\check-ffmpeg-release-compliance.cjs') --root $FfmpegBuildRoot --skip-capabilities
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg release compliance gate failed before release staging.' }

New-Item -ItemType Directory -Path $ReleaseRoot, $UpdaterRoot, $InstallerRoot, $DocsRoot, $SourceRoot, $ChecksumsRoot, $DownloadsRoot -Force | Out-Null

foreach ($directory in @($RuntimeRoot, $InstallerRoot, $DocsRoot, $SourceRoot, $ChecksumsRoot, $DownloadsRoot)) {
  Reset-Directory $directory
}

Get-ChildItem -LiteralPath $ReleaseRoot -Directory -Filter 'Vast-*' | Where-Object { $_.Name -ne "Vast-$Version" } | ForEach-Object {
  $resolved = $_.FullName
  $release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
  if (-not $resolved.StartsWith($release, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside release root: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

# Test packages are deliberately tagged with the smoke-* prefix. Never allow a
# previous QA run to become part of a release scan or checksum manifest.
Get-ChildItem -LiteralPath $ReleaseRoot -Directory -Filter 'smoke-*' | ForEach-Object {
  $resolved = $_.FullName
  $release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
  if (-not $resolved.StartsWith($release, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside release root: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

Get-ChildItem -LiteralPath $UpdaterRoot -File -Filter 'VastUpdater-*.exe' | Where-Object { $_.Name -ne "VastUpdater-$Version.exe" } | Remove-Item -Force
Get-ChildItem -LiteralPath $ReleaseRoot -File -Filter 'Vast-Setup-*.exe' | Where-Object { $_.Name -ne "Vast-Setup-$Version.exe" } | Remove-Item -Force
Get-ChildItem -LiteralPath $ReleaseRoot -File -Filter 'Vast-Setup-*.exe.blockmap' | Where-Object { $_.Name -ne "Vast-Setup-$Version.exe.blockmap" } | Remove-Item -Force
Get-ChildItem -LiteralPath $ReleaseRoot -File -Filter 'Vast-*-Portable.exe' | Where-Object { $_.Name -ne "Vast-$Version-Portable.exe" } | Remove-Item -Force

$VersionedUpdaterConfigPath = New-VersionedUpdaterConfig -SourcePath $UpdaterConfigPath -Version $Version
Copy-Item -LiteralPath $VersionedUpdaterConfigPath -Destination $UpdaterConfigPath -Force

Reset-Directory $RuntimePayload

Copy-Item -Path (Join-Path $WinUnpacked '*') -Destination $RuntimePayload -Recurse -Force
$runtimeVersionInfo = [pscustomobject]@{
  product = 'Vast Browser'
  productName = 'Vast'
  appId = 'app.vast.browser'
  version = $Version
  channel = $Channel
  platform = 'win32-x64'
  buildDate = (Get-Date).ToUniversalTime().ToString('o')
  sourceCommit = $SourceCommit
  signaturePolicy = $SignaturePolicy
  generatedBy = 'scripts/prepare-release.ps1'
}
$runtimeVersionInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $RuntimePayload 'version.json') -Encoding UTF8
New-Item -ItemType Directory -Path (Join-Path $RuntimePayload 'resources') -Force | Out-Null
$runtimeVersionInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $RuntimePayload 'resources\version.json') -Encoding UTF8
$setupSource = Join-Path $ReleaseRoot $InstallerSetupName
if (-not (Test-Path -LiteralPath $setupSource -PathType Leaf)) { $setupSource = Join-Path $ReleaseRoot "Vast-Setup-$Version.exe" }
$blockmapSource = Join-Path $ReleaseRoot $InstallerBlockmapName
if (-not (Test-Path -LiteralPath $blockmapSource -PathType Leaf)) { $blockmapSource = Join-Path $ReleaseRoot "Vast-Setup-$Version.exe.blockmap" }
$portableSource = Join-Path $ReleaseRoot $InstallerPortableName
if (-not (Test-Path -LiteralPath $portableSource -PathType Leaf)) { $portableSource = Join-Path $ReleaseRoot "Vast-$Version-Portable.exe" }
Copy-Item -LiteralPath $setupSource -Destination (Join-Path $InstallerRoot $InstallerSetupName) -Force
Copy-Item -LiteralPath $blockmapSource -Destination (Join-Path $InstallerRoot $InstallerBlockmapName) -Force
Copy-Item -LiteralPath $portableSource -Destination (Join-Path $InstallerRoot $InstallerPortableName) -Force
Copy-Item -LiteralPath (Join-Path $ReleaseRoot 'latest.yml') -Destination (Join-Path $InstallerRoot 'latest.yml') -Force

foreach ($stagingPath in @(
  $WinUnpacked,
  (Join-Path $ReleaseRoot '.icon-ico'),
  (Join-Path $ReleaseRoot "Vast-Setup-$Version.exe"),
  (Join-Path $ReleaseRoot "Vast-Setup-$Version.exe.blockmap"),
  (Join-Path $ReleaseRoot "Vast-$Version-Portable.exe"),
  (Join-Path $ReleaseRoot 'builder-debug.yml'),
  (Join-Path $ReleaseRoot 'builder-effective-config.yaml'),
  (Join-Path $ReleaseRoot 'latest.yml')
)) {
  if (Test-Path -LiteralPath $stagingPath) {
    $resolved = (Resolve-Path -LiteralPath $stagingPath).Path
    $release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
    if (-not $resolved.StartsWith($release, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside release root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

New-FileManifest -Root $RuntimePayload -OutPath (Join-Path $RuntimeRoot 'runtime-manifest.json') -Product 'Vast Browser Runtime' -Version $Version

$bundleStage = Join-Path $ReleaseRoot ".bundle-$Version"
Reset-Directory $bundleStage
New-Item -ItemType Directory -Path (Join-Path $bundleStage "Vast-$Version"), (Join-Path $bundleStage 'Updater') -Force | Out-Null
Copy-Item -LiteralPath $RuntimePayload -Destination (Join-Path $bundleStage "Vast-$Version\win-unpacked") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $UpdaterRoot 'VastUpdater.ps1') -Destination (Join-Path $bundleStage 'Updater\VastUpdater.ps1') -Force
Copy-Item -LiteralPath $VersionedUpdaterConfigPath -Destination (Join-Path $bundleStage 'Updater\updater.config.json') -Force
if (Test-Path -LiteralPath (Join-Path $UpdaterRoot 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $UpdaterRoot 'README.md') -Destination (Join-Path $bundleStage 'Updater\README.md') -Force
}

$updateZip = Join-Path $DownloadsRoot "Vast-$Version-update.zip"
if (Test-Path -LiteralPath $updateZip) {
  Remove-Item -LiteralPath $updateZip -Force
}
Compress-Archive -Path (Join-Path $bundleStage '*') -DestinationPath $updateZip -CompressionLevel Optimal
Remove-Item -LiteralPath $bundleStage -Recurse -Force

$zipItem = Get-Item -LiteralPath $updateZip
$zipSha256 = (Get-FileHash -LiteralPath $updateZip -Algorithm SHA256).Hash.ToLowerInvariant()
$packageUrl = "Vast-$Version-update.zip"
$remotePackageUrl = ([System.Uri]::new([System.Uri]::new($UpdateBaseUrl), $packageUrl)).ToString()

$downloadManifest = [pscustomobject]@{
  product = 'Vast Browser'
  version = $Version
  previousVersion = $PreviousVersion
  channel = $Channel
  platform = 'win32-x64'
  publishedAt = (Get-Date).ToUniversalTime().ToString('o')
  sourceCommit = $SourceCommit
  signaturePolicy = $SignaturePolicy
  package = [pscustomobject]@{
    url = $packageUrl
    remoteUrl = $remotePackageUrl
    sha256 = $zipSha256
    size = $zipItem.Length
    entrypoint = 'Updater/VastUpdater.ps1'
    configPath = 'Updater/updater.config.json'
    payloadPath = "Vast-$Version/win-unpacked"
  }
}
$downloadManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $DownloadsRoot 'update-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $DownloadsRoot 'update-manifest.json') -Destination (Join-Path $UpdaterRoot 'update-manifest.sample.json') -Force

@'
# Vast 1.1.0 Single-File Updater

Primary updater:

```powershell
.\VastUpdater-1.1.0.exe
```

The executable is a small online bootstrapper. It downloads `update-manifest.json` and `Vast-1.1.0-update.zip` from the configured public GitHub Releases repo, verifies SHA-256, then applies the normal safe Vast update flow. It can also use a local `..\Downloads\update-manifest.json` when distributed in the full release ZIP.

## Common commands

Hosted release update:

```powershell
.\VastUpdater-1.1.0.exe -ForceClose
```

Use a custom hosted or local manifest:

```powershell
.\VastUpdater-1.1.0.exe --manifest-url "https://github.com/vstxx/vast-public/releases/download/v1.1.0/update-manifest.json" -ForceClose
.\VastUpdater-1.1.0.exe --manifest-url "..\Downloads\update-manifest.json" -ForceClose
```

Custom install path:

```powershell
.\VastUpdater-1.1.0.exe --manifest-url "..\Downloads\update-manifest.json" -InstallPath "D:\Apps\Vast" -ForceClose
```

Low disk space on the system drive:

```powershell
.\VastUpdater-1.1.0.exe -BackupRoot "E:\VastBackups" -ForceClose
```

Keep downloaded files for diagnostics:

```powershell
.\VastUpdater-1.1.0.exe --keep-downloads
```

## Hosting

For online distribution from a public repo, create a public GitHub repository such as `vstxx/vast-public`, create release tag `v1.1.0`, and upload these assets to that release:

- `update-manifest.json`
- `Vast-1.1.0-update.zip`
- `VastUpdater-1.1.0.exe`

The updater default manifest URL should look like:

```text
https://github.com/vstxx/vast-public/releases/download/v1.1.0/update-manifest.json
```

## Safety behavior

- Downloads the manifest and update bundle into `%LOCALAPPDATA%\Vast\UpdaterDownloads\1.1.0`.
- Verifies the downloaded bundle SHA-256 before extraction.
- Extracts to a temporary folder and runs the downloaded `VastUpdater.ps1`.
- The downloaded updater detects install paths, backs up critical user data, preserves profiles/settings/bookmarks/password vault data, repairs same-version runtime drift, and rolls back failed file copies. Use `-BackupRoot` to place the backup on another drive.
- The downloaded updater reads `%APPDATA%\Vast\data-root.json` and preserves a configured custom Vast data directory before falling back to default/legacy data roots.
- Writes bootstrapper logs to `%LOCALAPPDATA%\Vast\UpdaterLogs\VastUpdaterBootstrapper-1.1.0.log`.
- The production updater writes logs to `%LOCALAPPDATA%\Vast\UpdaterLogs\VastUpdater-1.1.0.log`.

The legacy script launcher remains in this folder for diagnostics, but the supported distributable updater is the generated single-file updater EXE.
'@ | Set-Content -LiteralPath (Join-Path $UpdaterRoot 'README.md') -Encoding UTF8

foreach ($publicUpdaterScriptLauncher in @(
  (Join-Path $UpdaterRoot 'VastUpdater.cmd')
)) {
  if (Test-Path -LiteralPath $publicUpdaterScriptLauncher) {
    Remove-Item -LiteralPath $publicUpdaterScriptLauncher -Force
  }
}

@'
# Vast Browser 1.1.0 Release Package

This folder contains the production release package for Vast Browser 1.1.0 for Windows x64.

## Hosted updater distribution

For normal hosted updates, create a public GitHub release in `vstxx/vast-public`:

- Tag: `v1.1.0`

Upload these release assets:

- `update-manifest.json`
- `Vast-1.1.0-update.zip`
- `VastUpdater-1.1.0.exe`

Then users can run only the small updater EXE. It downloads the manifest and update ZIP from GitHub Releases.

## Structure

- `Vast-1.1.0/win-unpacked/` - unpacked runtime used by the updater and for inspection.
- `Updater/VastUpdater-1.1.0.exe` - self-contained online updater bootstrapper.
- `Downloads/update-manifest.json` - manifest consumed by the updater.
- `Downloads/Vast-1.1.0-update.zip` - downloadable updater bundle containing runtime payload and safe updater script.
- `Installer/` - Windows installer, portable executable, blockmap, and `latest.yml`.
- `Docs/` - technical notes, release manifest, and updater runbook.
- `Checksums/` - SHA-256 and SHA-512 checksums for current 1.1.0 release files.
- `version.json`, `changelog.md`, `release-notes.md` - release metadata and notes.

## Local/offline testing from this release folder

```powershell
Updater\VastUpdater-1.1.0.exe --manifest-url ".\Downloads\update-manifest.json" -ForceClose
```

The updater downloads required resources, verifies SHA-256, creates a critical user-data backup, preserves user data, and applies only runtime file changes.

The installer lets users choose the app install directory. Vast data stays separate from app files; users can export/import `.vastbackup` archives or change the active data directory from Settings -> Data.
'@ | Set-Content -LiteralPath (Join-Path $ReleaseRoot 'README.md') -Encoding UTF8

@'
# Vast Browser 1.1.0 Changelog

Changes since 1.0.11:

- Added the experimental Purist layout with a compact Topbar Island, functional tab strip, shared browser controls, and browser-owned overscroll space.
- Made experimental layout choices disappear completely while Experimental features is disabled, with safe fallback to Horizontal for stale Purist profiles.
- Updated Smart Unload to use dedicated Dark, Dim, and Light surfaces; Dark now matches Vast's near-black canvas.
- Hardened production packages with verified Electron Fuses, fail-closed public signing checks, selective obfuscation evidence, and stricter release verification.
- Strengthened Labs IPC enforcement, password-vault session locking, guest autofill isolation, and runtime feature policy checks.
- Added a passive, signed Vast Notices feed configuration that remains disabled unless a dedicated HTTPS origin and pinned Ed25519 key are supplied.
- Improved split-view behavior, Purist window controls, local privacy-list matching, and final interface polish.
- Refreshed the installer, portable build, standalone updater, update bundle, manifests, release notes, and checksums for 1.1.0.
'@ | Set-Content -LiteralPath (Join-Path $ReleaseRoot 'changelog.md') -Encoding UTF8

@'
# Vast Browser 1.1.0 Release Notes

Vast 1.1.0 is a layout, interface-polish, and release-hardening update. It introduces the optional Purist layout, tightens experimental-feature visibility, and makes Smart Unload follow Dark, Dim, and Light themes directly.

The release also strengthens Electron Fuse verification, Labs IPC gates, password-vault session locking, guest autofill isolation, updater verification, and opt-in signed notice-feed handling. Purist remains hidden unless Experimental features is enabled and falls back safely when that setting is turned off.

The public updater is a small online standalone updater for the single Vast payload. It downloads `update-manifest.json` and `Vast-1.1.0-update.zip`, verifies SHA-256, and applies the safe runtime update while preserving user data. Public stable Windows executables are required to carry a valid timestamped Authenticode signature.

Update behavior remains focused on preserving user data. Existing website logins continue to use the pre-update cookie store, and the updater backs up critical user data before runtime files are replaced.

Existing full-profile `.vastbackup` export/import and custom data directory migration remain compatible. Existing Electron profile data is reused in place by a normal update. Password-vault encryption and website session portability remain operating-system and browser-runtime dependent.

This package is generated as an internal unsigned beta only when `npm run release:internal` is used. Public beta and stable packages both require the complete signing and verification gate.
'@ | Set-Content -LiteralPath (Join-Path $ReleaseRoot 'release-notes.md') -Encoding UTF8

@'
# Vast Browser 1.1.0 Technical Update Notes

## Single-file online updater flow

1. `VastUpdater-1.1.0.exe` reads a manifest URL from `--manifest-url`, `VAST_UPDATE_MANIFEST_URL`, a bundled local `Downloads/update-manifest.json`, or the compiled default GitHub Releases URL.
2. The default hosted URL uses the separate public release repo: `https://github.com/vstxx/vast-public/releases/download/v1.1.0/update-manifest.json`.
3. The manifest points to `Vast-1.1.0-update.zip` in the same GitHub release asset set.
4. The updater downloads the ZIP, verifies SHA-256, and extracts it under `%LOCALAPPDATA%\Vast\UpdaterDownloads\1.1.0`.
5. The bootstrapper launches the downloaded `Updater/VastUpdater.ps1` with `-TargetVersion 1.1.0`, manifest config, payload path, and user pass-through arguments.
6. The PowerShell updater performs install detection, process handling, user-data backup, runtime replacement, rollback, and registry metadata update.

## Distribution

For online distribution, host these files as assets in the public GitHub release:

- `update-manifest.json`
- `Vast-1.1.0-update.zip`
- `VastUpdater-1.1.0.exe`

The updater checks `%APPDATA%\Vast\data-root.json` first so a custom Vast data directory is preserved during updates.

For offline QA, run either command from the release root:

```powershell
Updater\VastUpdater-1.1.0.exe -ForceClose
Updater\VastUpdater-1.1.0.exe --manifest-url ".\Downloads\update-manifest.json" -ForceClose
```
'@ | Set-Content -LiteralPath (Join-Path $DocsRoot 'technical-update-notes.md') -Encoding UTF8

@'
# Vast 1.1.0 Updater Runbook

## Online update from public GitHub Releases

After uploading release assets to `vstxx/vast-public`, users can run:

```powershell
VastUpdater-1.1.0.exe -ForceClose
```

The public updater default manifest URL is:

```text
https://github.com/vstxx/vast-public/releases/download/v1.1.0-free/update-manifest.json
```

## Custom manifest

```powershell
VastUpdater-1.1.0.exe --manifest-url "https://github.com/vstxx/vast-public/releases/download/v1.1.0-free/update-manifest.json" -ForceClose
```

## Local package validation

```powershell
Updater\VastUpdater-1.1.0.exe --manifest-url ".\Downloads\update-manifest.json" -ForceClose
```

## Logs

- Bootstrapper: `%LOCALAPPDATA%\Vast\UpdaterLogs\VastUpdaterBootstrapper-1.1.0.log`
- Production updater: `%LOCALAPPDATA%\Vast\UpdaterLogs\VastUpdater-1.1.0.log`

## Recovery

If an update fails after backup creation, inspect the updater log and the backup path printed in the console. The PowerShell updater rolls back runtime files automatically when the copy phase fails.
'@ | Set-Content -LiteralPath (Join-Path $DocsRoot 'updater-runbook.md') -Encoding UTF8

foreach ($releaseDocument in @(
  (Join-Path $UpdaterRoot 'README.md'),
  (Join-Path $ReleaseRoot 'README.md'),
  (Join-Path $ReleaseRoot 'changelog.md'),
  (Join-Path $ReleaseRoot 'release-notes.md'),
  (Join-Path $DocsRoot 'technical-update-notes.md'),
  (Join-Path $DocsRoot 'updater-runbook.md')
)) {
  $content = Get-Content -Raw -LiteralPath $releaseDocument
  $content = $content.Replace('1.1.0', $Version).Replace('1.0.11', $PreviousVersion)
  $content = $content.Replace("v$Version-free", "v$Version")
  Set-Content -LiteralPath $releaseDocument -Value $content -Encoding UTF8
}

Copy-Item -LiteralPath (Join-Path $RepoRoot 'docs\DATA_MIGRATION_AND_STORAGE.md') -Destination (Join-Path $DocsRoot 'data-migration-and-storage.md') -Force
Copy-Item -LiteralPath $FfmpegProvenance -Destination (Join-Path $DocsRoot 'ffmpeg-build-provenance.json') -Force
Copy-Item -LiteralPath $FfmpegCapabilities -Destination (Join-Path $DocsRoot 'avidae-ffmpeg-capabilities.json') -Force
Copy-Item -LiteralPath $FfmpegSourceBundle -Destination (Join-Path $SourceRoot 'ffmpeg-corresponding-source-win64.tar.zst') -Force

$versionJson = [pscustomobject]@{
  product = 'Vast Browser'
  productName = 'Vast'
  appId = 'app.vast.browser'
  version = $Version
  previousVersion = $PreviousVersion
  channel = $Channel
  platform = 'win32-x64'
  releaseDate = (Get-Date).ToString('yyyy-MM-dd')
  sourceCommit = $SourceCommit
  signaturePolicy = $SignaturePolicy
  artifacts = [pscustomobject]@{
    nsis = "Installer/$InstallerSetupName"
    portable = "Installer/$InstallerPortableName"
    blockmap = "Installer/$InstallerBlockmapName"
    latest = 'Installer/latest.yml'
    runtime = "Vast-$Version/win-unpacked"
    downloadableUpdate = "Downloads/Vast-$Version-update.zip"
    downloadManifest = 'Downloads/update-manifest.json'
    ffmpegProvenance = 'Docs/ffmpeg-build-provenance.json'
    ffmpegCapabilities = 'Docs/avidae-ffmpeg-capabilities.json'
    ffmpegCorrespondingSource = 'Source/ffmpeg-corresponding-source-win64.tar.zst'
  }
  updater = [pscustomobject]@{
    entrypoint = "Updater/VastUpdater-$Version.exe"
    kind = 'single-file-online-bootstrapper'
    targetVersion = $Version
    manifest = 'Downloads/update-manifest.json'
    defaultRemoteManifest = ([System.Uri]::new([System.Uri]::new($UpdateBaseUrl), 'update-manifest.json')).ToString()
    defaultLogPath = "%LOCALAPPDATA%/Vast/UpdaterLogs/VastUpdaterBootstrapper-$Version.log"
  }
  checksums = [pscustomobject]@{
    sha256 = 'Checksums/SHA256SUMS.txt'
    sha512 = 'Checksums/SHA512SUMS.txt'
    json = 'Checksums/checksums.json'
  }
}
$versionJson | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ReleaseRoot 'version.json') -Encoding UTF8

$releaseManifest = [pscustomobject]@{
  product = 'Vast Browser'
  version = $Version
  channel = $Channel
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  sourceCommit = $SourceCommit
  signaturePolicy = $SignaturePolicy
  runtimeManifest = "Vast-$Version/runtime-manifest.json"
  downloadManifest = 'Downloads/update-manifest.json'
  updater = "Updater/VastUpdater-$Version.exe"
  updateBundleSha256 = $zipSha256
  updateBundleSize = $zipItem.Length
  ffmpegProvenance = 'Docs/ffmpeg-build-provenance.json'
  ffmpegCapabilities = 'Docs/avidae-ffmpeg-capabilities.json'
  ffmpegCorrespondingSource = 'Source/ffmpeg-corresponding-source-win64.tar.zst'
}
$releaseManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $DocsRoot 'release-manifest.json') -Encoding UTF8

$InternalUnsignedMarker = Join-Path $ReleaseRoot 'INTERNAL-UNSIGNED.md'
$PublicUnsignedMarker = Join-Path $ReleaseRoot 'PUBLIC-UNSIGNED-BETA.md'
foreach ($marker in @($InternalUnsignedMarker, $PublicUnsignedMarker)) {
  if (Test-Path -LiteralPath $marker) {
    Remove-Item -LiteralPath $marker -Force
  }
}

if ($PublicUnsignedBetaEnabled) {
  @"
# PUBLIC UNSIGNED BETA

Vast $Version is a public beta whose Windows executables are intentionally unsigned.

- Windows will show **Unknown publisher** and Microsoft Defender SmartScreen may warn before launch.
- This build does not prove the publisher identity through Authenticode and has no RFC 3161 timestamp.
- Integrity is published through SHA-256/SHA-512 manifests and exact source commit: $SourceCommit.
- Download only from the official Vast website or vstxx/vast-public.
- A future signed release must use a newer version and a fresh immutable artifact set.
"@ | Set-Content -LiteralPath $PublicUnsignedMarker -Encoding UTF8

  foreach ($document in @((Join-Path $ReleaseRoot 'README.md'), (Join-Path $ReleaseRoot 'release-notes.md'))) {
    $body = Get-Content -Raw -LiteralPath $document
    "# Public unsigned beta`r`n`r`n**Warning:** this Windows beta is intentionally unsigned. Expect Unknown publisher/SmartScreen warnings. Verify the published SHA-256 before running it.`r`n`r`n$body" |
      Set-Content -LiteralPath $document -Encoding UTF8
  }
}

$checksumRelativeFiles = @()
$includeRoots = @(
  "Vast-$Version",
  'Updater',
  'Installer',
  'Docs',
  'Source',
  'Downloads'
)
foreach ($root in $includeRoots) {
  $path = Join-Path $ReleaseRoot $root
  if (Test-Path -LiteralPath $path) {
    $checksumRelativeFiles += Get-ChildItem -LiteralPath $path -File -Recurse
  }
}
$checksumRelativeFiles += @(
  (Join-Path $ReleaseRoot 'README.md'),
  (Join-Path $ReleaseRoot 'changelog.md'),
  (Join-Path $ReleaseRoot 'release-notes.md'),
  (Join-Path $ReleaseRoot 'version.json'),
  $PublicUnsignedMarker
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object { Get-Item -LiteralPath $_ }

$checksumRelativeFiles = $checksumRelativeFiles | Sort-Object FullName -Unique
$sha256Lines = New-Object System.Collections.Generic.List[string]
$sha512Lines = New-Object System.Collections.Generic.List[string]
$checksumJson = New-Object System.Collections.Generic.List[object]
foreach ($file in $checksumRelativeFiles) {
  $relative = $file.FullName.Substring($ReleaseRoot.Length).TrimStart('\') -replace '\\','/'
  $sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $sha512 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA512).Hash.ToLowerInvariant()
  $sha256Lines.Add("$sha256  $relative")
  $sha512Lines.Add("$sha512  $relative")
  $checksumJson.Add([pscustomobject]@{
    path = $relative
    size = $file.Length
    sha256 = $sha256
    sha512 = $sha512
  })
}

$sha256Lines | Set-Content -LiteralPath (Join-Path $ChecksumsRoot 'SHA256SUMS.txt') -Encoding ASCII
$sha512Lines | Set-Content -LiteralPath (Join-Path $ChecksumsRoot 'SHA512SUMS.txt') -Encoding ASCII
[pscustomobject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  version = $Version
  channel = $Channel
  signaturePolicy = $SignaturePolicy
  files = $checksumJson
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ChecksumsRoot 'checksums.json') -Encoding UTF8

if (-not $PublicDistribution) {
  @"
# INTERNAL UNSIGNED BUILD

Vast $Version is an internal unsigned $Channel build. It is intended for controlled QA only and is not a public distribution.

- Windows executables are intentionally unsigned.
- SmartScreen warnings are expected.
- Use the bundled local update manifest for updater testing.
- Do not publish these assets to the public `vstxx/vast-public` repository.
"@ | Set-Content -LiteralPath $InternalUnsignedMarker -Encoding UTF8

  $releaseNotesPath = Join-Path $ReleaseRoot 'release-notes.md'
  $releaseNotes = Get-Content -Raw -LiteralPath $releaseNotesPath
  "# Internal unsigned $Channel build`r`n`r`nThis package is not a public distribution.`r`n`r`n$releaseNotes" |
    Set-Content -LiteralPath $releaseNotesPath -Encoding UTF8
}

Write-Host "Prepared Vast $Version release package."
Write-Host "Single-file updater: $(Join-Path $UpdaterRoot "VastUpdater-$Version.exe")"
Write-Host "Download manifest: $(Join-Path $DownloadsRoot 'update-manifest.json')"
Write-Host "Update bundle: $updateZip"
Write-Host "Public GitHub release tag: v$Version"
Write-Host "Public manifest URL: $(([System.Uri]::new([System.Uri]::new($UpdateBaseUrl), 'update-manifest.json')).ToString())"
