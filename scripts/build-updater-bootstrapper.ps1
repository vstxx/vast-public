param(
  [string] $Version = '',
  [string] $DefaultManifestUrl = '',
  [ValidateSet('internal-unsigned', 'unsigned-public-release', 'authenticode-signed')]
  [string] $SignaturePolicy = 'internal-unsigned',
  [string] $ExpectedSignerSubject = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json).version
}
$Project = Join-Path $RepoRoot 'tools\VastUpdaterBootstrapper\VastUpdaterBootstrapper.csproj'
$GeneratedConstants = Join-Path $RepoRoot 'tools\VastUpdaterBootstrapper\VastUpdaterBootstrapperConstants.Generated.cs'
$UpdaterScript = Join-Path $RepoRoot 'release\Updater\VastUpdater.ps1'
$PublishDir = Join-Path $RepoRoot 'release\Updater\single-file'
$OutputExe = Join-Path $RepoRoot "release\Updater\VastUpdater-$Version.exe"

if (-not (Test-Path -LiteralPath $Project -PathType Leaf)) {
  throw "Bootstrapper project missing: $Project"
}
if (-not (Test-Path -LiteralPath $UpdaterScript -PathType Leaf)) {
  throw "Staged updater script missing: $UpdaterScript"
}

if ([string]::IsNullOrWhiteSpace($DefaultManifestUrl)) {
  $DefaultManifestUrl = "https://github.com/vstxx/vast-public/releases/download/v$Version/update-manifest.json"
}

if (-not $DefaultManifestUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DefaultManifestUrl must use HTTPS: $DefaultManifestUrl"
}
if ($SignaturePolicy -eq 'authenticode-signed' -and [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
  throw 'ExpectedSignerSubject is required for an authenticode-signed updater.'
}

$escapedVersion = $Version.Replace('\', '\\').Replace('"', '\"')
$escapedDefaultManifestUrl = $DefaultManifestUrl.Replace('\', '\\').Replace('"', '\"')
$escapedSignaturePolicy = $SignaturePolicy.Replace('\', '\\').Replace('"', '\"')
$escapedExpectedSignerSubject = $ExpectedSignerSubject.Replace('\', '\\').Replace('"', '\"')
# The release workflow launches Windows PowerShell from PowerShell 7. Its
# inherited PSModulePath may not contain the Windows PowerShell utility module,
# so hash the staged file directly without relying on Get-FileHash autoloading.
$hashStream = [System.IO.File]::OpenRead($UpdaterScript)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $updaterScriptSha256 = ([System.BitConverter]::ToString($sha256.ComputeHash($hashStream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $hashStream.Dispose()
}
$logFileName = "VastUpdaterBootstrapper-$Version.log"
$escapedLogFileName = $logFileName.Replace('\', '\\').Replace('"', '\"')

@"
internal static partial class VastUpdaterBootstrapperConstants
{
  public const string TargetVersion = "$escapedVersion";
  public const string DefaultManifestUrl = "$escapedDefaultManifestUrl";
  public static readonly string ExpectedSignaturePolicy = "$escapedSignaturePolicy";
  public static readonly string ExpectedSignerSubject = "$escapedExpectedSignerSubject";
  public const string ExpectedUpdaterScriptSha256 = "$updaterScriptSha256";
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
