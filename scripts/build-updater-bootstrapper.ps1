param(
  [string] $Version = '0.2.7',
  [string] $DefaultManifestUrl = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$Project = Join-Path $RepoRoot 'tools\VastUpdaterBootstrapper\VastUpdaterBootstrapper.csproj'
$GeneratedConstants = Join-Path $RepoRoot 'tools\VastUpdaterBootstrapper\VastUpdaterBootstrapperConstants.Generated.cs'
$PublishDir = Join-Path $RepoRoot 'release\Updater\single-file'
$OutputExe = Join-Path $RepoRoot "release\Updater\VastUpdater-$Version.exe"

if (-not (Test-Path -LiteralPath $Project -PathType Leaf)) {
  throw "Bootstrapper project missing: $Project"
}

if ([string]::IsNullOrWhiteSpace($DefaultManifestUrl)) {
  $DefaultManifestUrl = "https://github.com/vstxx/vast-public/releases/download/v$Version/update-manifest.json"
}

if (-not $DefaultManifestUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DefaultManifestUrl must use HTTPS: $DefaultManifestUrl"
}

$escapedVersion = $Version.Replace('\', '\\').Replace('"', '\"')
$escapedDefaultManifestUrl = $DefaultManifestUrl.Replace('\', '\\').Replace('"', '\"')
$logFileName = "VastUpdaterBootstrapper-$Version.log"
$escapedLogFileName = $logFileName.Replace('\', '\\').Replace('"', '\"')

@"
internal static partial class VastUpdaterBootstrapperConstants
{
  public const string TargetVersion = "$escapedVersion";
  public const string DefaultManifestUrl = "$escapedDefaultManifestUrl";
  public const string LogFileName = "$escapedLogFileName";
}
"@ | Set-Content -LiteralPath $GeneratedConstants -Encoding UTF8

dotnet publish $Project `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:PublishTrimmed=false `
  -o $PublishDir

$publishedExe = Join-Path $PublishDir 'VastUpdater.exe'
if (-not (Test-Path -LiteralPath $publishedExe -PathType Leaf)) {
  throw "Published updater exe missing: $publishedExe"
}

Copy-Item -LiteralPath $publishedExe -Destination $OutputExe -Force
Remove-Item -LiteralPath $PublishDir -Recurse -Force
Write-Host "Built single-file updater: $OutputExe"
Write-Host "Default manifest URL: $DefaultManifestUrl"
