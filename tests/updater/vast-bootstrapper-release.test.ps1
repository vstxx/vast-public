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
Assert-True ($source -match 'ExtractUpdateBundle') 'bootstrapper should validate and extract the downloaded update bundle'
Assert-True ($source -notmatch 'ZipFile\.ExtractToDirectory') 'bootstrapper must not use unvalidated bulk ZIP extraction'
Assert-True ($source -match 'ReparsePoint') 'bootstrapper should reject symlink, junction, and reparse-point extraction paths'
Assert-True ($source -match 'CON\|PRN\|AUX\|NUL\|COM\[1-9\]\|LPT\[1-9\]') 'bootstrapper should reject reserved Windows device names'
Assert-True ($source -match 'package size mismatch') 'bootstrapper should verify the exact manifest package size'
Assert-True ($source -match 'ExpectedSignaturePolicy') 'bootstrapper should bind the manifest to its compiled release signature policy'
Assert-True ($source -match 'VerifyAuthenticodeSignature') 'signed bootstrapper should verify the extracted Vast executable before running downloaded updater code'
Assert-True ($source -match 'ExpectedSignerSubject') 'signed bootstrapper should bind payload verification to the expected publisher'
Assert-True ($source -match 'ExpectedUpdaterScriptSha256') 'bootstrapper should bind downloaded updater code to the script staged at build time'
Assert-True ($source.IndexOf('VerifyUpdaterScript(updaterScript)') -lt $source.IndexOf('RunPowerShellUpdaterAsync(updaterScript')) 'downloaded updater script hash verification must happen before it executes'
Assert-True ($source.IndexOf('VerifyAuthenticodeSignature(Path.Combine(payloadPath, "Vast.exe")') -lt $source.IndexOf('RunPowerShellUpdaterAsync(updaterScript')) 'payload signature verification must happen before downloaded updater code executes'
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
Assert-True ($buildScript -match "ValidateSet\('internal-unsigned', 'unsigned-public-release', 'authenticode-signed'\)") 'bootstrapper build should accept only known signature policies'
Assert-True ($buildScript -match 'ExpectedSignerSubject is required') 'signed bootstrapper build should fail without an expected publisher'
Assert-True ($buildScript -match '\[System\.IO\.File\]::OpenRead\(\$UpdaterScript\)' -and $buildScript -match '\$sha256\.ComputeHash\(\$hashStream\)') 'bootstrapper build should compile the exact staged updater script SHA-256 without PowerShell module autoloading'
Assert-True ($buildScript -match 'https://github.com/vstxx/vast-public/releases/download/v\$Version/update-manifest\.json') 'default updater URL should target the public vast-public repo'
Assert-True ($buildScript -notmatch 'updates\.vastbrowser\.app') 'bootstrapper must not default to the unconfigured updates.vastbrowser.app host'
Assert-True ($releaseScript -match 'VAST_RELEASE_REPO') 'release build should allow overriding the public release repo'
Assert-True ($releaseScript -match 'vstxx/vast-public') 'release build should default hosted updater assets to the public vast-public repo'
Assert-True ($releaseScript -match 'v\$\{pkg\.version\}/update-manifest\.json') 'release build should use the single-product GitHub release tag'
Assert-True ($releaseScript -match "'-SignaturePolicy'") 'release build should compile its exact signature policy into the standalone updater'
Assert-True ($releaseScript -match 'VAST_EXPECTED_SIGNER_SUBJECT') 'release build should compile the expected publisher into a signed standalone updater'

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
