$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$PackageJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
$Version = [string] $PackageJson.version
$BootstrapperRoot = Join-Path $RepoRoot 'tools\VastUpdaterBootstrapper'
$ProgramPath = Join-Path $BootstrapperRoot 'Program.cs'
$ProjectPath = Join-Path $BootstrapperRoot 'VastUpdaterBootstrapper.csproj'
$ApplicationManifestPath = Join-Path $BootstrapperRoot 'app.manifest'
$ManifestPath = Join-Path $RepoRoot 'release\Downloads\update-manifest.json'
$BootstrapperBuildScript = Join-Path $RepoRoot 'scripts\build-updater-bootstrapper.ps1'
$BuildReleaseScript = Join-Path $RepoRoot 'scripts\build-release.cjs'
$BootstrapperExe = Join-Path $RepoRoot "release\Updater\VastUpdater-$Version.exe"
$CanonicalUpdaterConfigPath = Join-Path $RepoRoot 'release\Updater\updater.config.json'

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

Assert-True (Test-Path -LiteralPath $ProjectPath -PathType Leaf) 'single-file updater project should exist'
Assert-True (Test-Path -LiteralPath $ProgramPath -PathType Leaf) 'single-file updater source should exist'
Assert-True (Test-Path -LiteralPath $ApplicationManifestPath -PathType Leaf) 'single-file updater application manifest should exist'
Assert-True (Test-Path -LiteralPath $BootstrapperBuildScript -PathType Leaf) 'single-file updater build script should exist'
Assert-True (Test-Path -LiteralPath $BuildReleaseScript -PathType Leaf) 'single-product release build script should exist'

$source = Get-Content -Raw -LiteralPath $ProgramPath
$project = Get-Content -Raw -LiteralPath $ProjectPath
$applicationManifest = Get-Content -Raw -LiteralPath $ApplicationManifestPath
$buildScript = Get-Content -Raw -LiteralPath $BootstrapperBuildScript
$releaseScript = Get-Content -Raw -LiteralPath $BuildReleaseScript
Assert-True ($source -match 'VAST_UPDATE_MANIFEST_URL') 'bootstrapper should support an environment manifest URL'
Assert-True ($source -match '--manifest-url') 'bootstrapper should support a command-line manifest URL'
Assert-True ($source -match 'SHA256') 'bootstrapper should verify downloaded package SHA-256'
Assert-True ($source -match 'ZipFile\.ExtractToDirectory') 'bootstrapper should extract the downloaded update bundle'
Assert-True ($source -match 'VastUpdater\.ps1') 'bootstrapper should delegate to the downloaded production updater'
Assert-True ($source -match 'VastUpdaterBootstrapperConstants\.Generated\.cs') 'bootstrapper version constants should come from a generated build-time source file'
Assert-True ($source -match 'Press Enter to close') 'bootstrapper should keep interactive failure output visible'
Assert-True ($source -match 'Console\.IsInputRedirected') 'bootstrapper should not pause non-interactive automation'
Assert-True ($project -match '<ApplicationManifest>app\.manifest</ApplicationManifest>') 'bootstrapper project should embed the Windows application manifest'
Assert-True ($applicationManifest -match 'requestedExecutionLevel level="requireAdministrator"') 'bootstrapper should request administrator rights through UAC'
Assert-True ($buildScript -match [regex]::Escape('VastUpdaterBootstrapperConstants.Generated.cs')) 'bootstrapper build should generate version constants'
Assert-True ($buildScript -match [regex]::Escape('public const string TargetVersion = "$escapedVersion";')) 'bootstrapper build should inject the requested target version'
Assert-True ($buildScript -notmatch 'TargetEdition') 'bootstrapper build should not generate target edition metadata'
Assert-True ($buildScript -match 'DefaultManifestUrl') 'bootstrapper build should accept an explicit default manifest URL'
Assert-True ($buildScript -match 'https://github.com/vstxx/vast-public/releases/download/v\$Version/update-manifest\.json') 'default updater URL should target the public vast-public repo'
Assert-True ($buildScript -notmatch 'updates\.vastbrowser\.app') 'bootstrapper must not default to the unconfigured updates.vastbrowser.app host'
Assert-True ($releaseScript -match 'VAST_RELEASE_REPO') 'release build should allow overriding the public release repo'
Assert-True ($releaseScript -match 'vstxx/vast-public') 'release build should default hosted updater assets to the public vast-public repo'
Assert-True ($releaseScript -match 'v\$\{pkg\.version\}/update-manifest\.json') 'release build should use the single-product GitHub release tag'

Assert-True (Test-Path -LiteralPath $CanonicalUpdaterConfigPath -PathType Leaf) 'canonical updater config should exist'
$updaterConfig = Get-Content -Raw -LiteralPath $CanonicalUpdaterConfigPath | ConvertFrom-Json
Assert-True (-not ($updaterConfig.PSObject.Properties.Name -contains 'targetEdition')) 'canonical updater config should not generate target edition metadata'
Assert-Equal $Version $updaterConfig.targetVersion 'canonical updater config should match generated package version'
Assert-True (([string] $updaterConfig.payloadPath).Contains("Vast-$Version")) 'canonical updater config should point at the generated package payload'

if (Test-Path -LiteralPath $BootstrapperExe -PathType Leaf) {
  Assert-True (Test-Path -LiteralPath $ManifestPath -PathType Leaf) 'a current candidate bootstrapper must have a matching download manifest'
  $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
  Assert-Equal $Version $manifest.version "download manifest should target $Version"
  Assert-True (-not [string]::IsNullOrWhiteSpace([string] $manifest.package.url)) 'download manifest should include package URL'
  Assert-True (($manifest.package.sha256 -as [string]) -match '^[a-fA-F0-9]{64}$') 'download manifest should include SHA-256'
  Assert-True ([int64] $manifest.package.size -gt 0) 'download manifest should include package size'
  Assert-True (-not ($manifest.PSObject.Properties.Name -contains 'edition')) 'download manifest should not generate edition metadata'
  Assert-True (-not ($manifest.package.PSObject.Properties.Name -contains 'edition')) 'download package should not generate edition metadata'
  Assert-True ((Get-Item -LiteralPath $BootstrapperExe).Length -gt 1024KB) 'single-file updater exe should be a real executable'
}

Write-Host 'Vast bootstrapper release tests passed.'
