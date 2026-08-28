param(
  [string] $OutputRoot = '.vast-build/ffmpeg',
  [string] $CacheRoot = '.vast-build/cache/ffmpeg',
  [string] $MsysRoot = '',
  [int] $Jobs = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LockPath = Join-Path $RepoRoot 'third_party/ffmpeg/ffmpeg-build.lock.json'
$Lock = Get-Content -Raw -LiteralPath $LockPath | ConvertFrom-Json

function Resolve-RepoPath([string] $Path) {
  $resolved = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
  if (-not $resolved.StartsWith($RepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path must remain inside the repository: $resolved"
  }
  return $resolved
}

function Get-Sha256([string] $Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-PinnedFile([string] $Url, [string] $Sha256, [string] $Destination) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $actual = Get-Sha256 $Destination
    if ($actual -eq $Sha256) { return }
    Remove-Item -LiteralPath $Destination -Force
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  $partial = "$Destination.partial"
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source --location --fail --silent --show-error --retry 3 --output $partial $Url
    if ($LASTEXITCODE -ne 0) {
      if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
      throw "Download failed for $Url."
    }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing -UserAgent 'Mozilla/5.0 Vast-FFmpeg-Builder/1.0'
  }
  $actual = Get-Sha256 $partial
  if ($actual -ne $Sha256) {
    Remove-Item -LiteralPath $partial -Force
    throw "SHA-256 mismatch for $Url. Expected $Sha256, got $actual."
  }
  Move-Item -LiteralPath $partial -Destination $Destination
}

function Get-PinnedGitArchive(
  [string] $RepositoryUrl,
  [string] $Commit,
  [string] $Tree,
  [string] $Sha256,
  [string] $Destination,
  [string] $Prefix
) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $actual = Get-Sha256 $Destination
    if ($actual -eq $Sha256) { return }
    Remove-Item -LiteralPath $Destination -Force
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to materialize the pinned x264 source tree.'
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  $checkout = Join-Path ([System.IO.Path]::GetTempPath()) ("vastffmpeg-git-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $checkout | Out-Null
  try {
    & git -C $checkout init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the temporary source repository.' }
    & git -C $checkout remote add origin $RepositoryUrl
    if ($LASTEXITCODE -ne 0) { throw "Could not configure the source repository $RepositoryUrl." }
    & git -C $checkout fetch --quiet --depth=1 origin $Commit
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch pinned source commit $Commit." }

    $actualCommit = ((& git -C $checkout rev-parse FETCH_HEAD) -join "`n").Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $Commit) {
      throw "Git commit mismatch. Expected $Commit, got $actualCommit."
    }
    $actualTree = ((& git -C $checkout rev-parse "$Commit`^{tree}") -join "`n").Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $actualTree -ne $Tree) {
      throw "Git tree mismatch for $Commit. Expected $Tree, got $actualTree."
    }

    $temporaryArchive = "$Destination.partial"
    if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
    & git -C $checkout archive --format=tar "--prefix=$Prefix/" -o $temporaryArchive $Commit
    if ($LASTEXITCODE -ne 0) { throw "Could not create deterministic source archive for $Commit." }
    $actual = Get-Sha256 $temporaryArchive
    if ($actual -ne $Sha256) {
      Remove-Item -LiteralPath $temporaryArchive -Force
      throw "Canonical Git archive mismatch for $Commit. Expected $Sha256, got $actual."
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $Destination
  } finally {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedCheckout = [System.IO.Path]::GetFullPath($checkout)
    if ($resolvedCheckout.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedCheckout)) {
      Remove-Item -LiteralPath $resolvedCheckout -Recurse -Force
    }
  }
}

function Invoke-Msys([string] $Bash, [string] $Command, [hashtable] $Environment = @{}) {
  $previous = @{}
  try {
    foreach ($entry in $Environment.GetEnumerator()) {
      $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
      [Environment]::SetEnvironmentVariable($entry.Key, [string] $entry.Value, 'Process')
    }
    & $Bash -lc $Command
    if ($LASTEXITCODE -ne 0) { throw "MSYS2 command failed with exit code $LASTEXITCODE." }
  } finally {
    foreach ($entry in $previous.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
  }
}

$Output = Resolve-RepoPath $OutputRoot
$Cache = Resolve-RepoPath $CacheRoot
New-Item -ItemType Directory -Path $Cache -Force | Out-Null

$OwnMsys = [string]::IsNullOrWhiteSpace($MsysRoot)
if ($OwnMsys) {
  $Installer = Join-Path $Cache 'msys2-base-x86_64-20260611.sfx.exe'
  Get-PinnedFile $Lock.buildToolchain.installerUrl $Lock.buildToolchain.installerSha256 $Installer
  $MsysContainer = Join-Path ([System.IO.Path]::GetTempPath()) 'vastffmpeg-msys2-20260611'
  $MsysRoot = Join-Path $MsysContainer 'msys64'
  if (-not (Test-Path -LiteralPath (Join-Path $MsysRoot 'usr/bin/bash.exe'))) {
    if (Test-Path -LiteralPath $MsysContainer) { Remove-Item -LiteralPath $MsysContainer -Recurse -Force }
    New-Item -ItemType Directory -Path $MsysContainer -Force | Out-Null
    & $Installer -y "-o$MsysContainer"
    if ($LASTEXITCODE -ne 0) { throw 'Pinned MSYS2 installer extraction failed.' }
  }
}
$MsysRoot = [System.IO.Path]::GetFullPath($MsysRoot)
$Bash = Join-Path $MsysRoot 'usr/bin/bash.exe'
if (-not (Test-Path -LiteralPath $Bash -PathType Leaf)) { throw "MSYS2 bash is missing: $Bash" }

if ($OwnMsys) {
  Invoke-Msys $Bash 'true'
  $PackageCache = Join-Path $Cache 'msys2-packages'
  $PackagePaths = @()
  foreach ($package in $Lock.buildToolchain.packages) {
    $destination = Join-Path $PackageCache $package.archive
    Get-PinnedFile ($package.baseUrl + $package.archive) $package.sha256 $destination
    $PackagePaths += $destination
  }
  $msysPackages = $PackagePaths | ForEach-Object { "'$($_ -replace '\\','/')'" }
  Invoke-Msys $Bash ("pacman -U --noconfirm --needed " + ($msysPackages -join ' '))
}

$ToolchainSources = Join-Path $Cache 'toolchain-sources'
foreach ($source in $Lock.buildToolchain.correspondingSources) {
  Get-PinnedFile ($source.baseUrl + $source.archive) $source.sha256 (Join-Path $ToolchainSources $source.archive)
  Get-PinnedFile ($source.baseUrl + $source.signature) $source.signatureSha256 (Join-Path $ToolchainSources $source.signature)
}

$Sources = Join-Path $Cache 'sources'
foreach ($source in $Lock.sources) {
  $destination = Join-Path $Sources $source.archive
  if ($source.sourceType -eq 'git') {
    Get-PinnedGitArchive $source.url $source.commit $source.tree $source.sha256 $destination ("x264-" + $source.commit)
  } else {
    Get-PinnedFile $source.url $source.sha256 $destination
  }
}

$BuildContainer = Join-Path ([System.IO.Path]::GetPathRoot($RepoRoot)) 'VastBuild'
$BuildRoot = Join-Path $BuildContainer 'ffmpeg-9.0.1'
$ResolvedBuildContainer = [System.IO.Path]::GetFullPath($BuildContainer)
$ResolvedBuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $ResolvedBuildRoot.StartsWith($ResolvedBuildContainer + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetFileName($ResolvedBuildRoot) -ne 'ffmpeg-9.0.1') {
  throw "Unsafe FFmpeg build root: $ResolvedBuildRoot"
}
$BuildRoot = $ResolvedBuildRoot
if ($BuildRoot.Contains(' ')) { throw "FFmpeg build root must not contain spaces: $BuildRoot" }
if ($Jobs -le 0) { $Jobs = [Math]::Max(1, [Environment]::ProcessorCount) }
$Environment = @{
  VAST_FFMPEG_REPO_ROOT = $RepoRoot
  VAST_FFMPEG_SOURCE_CACHE = $Sources
  VAST_FFMPEG_TOOLCHAIN_SOURCE_CACHE = $ToolchainSources
  VAST_FFMPEG_BUILD_ROOT = $BuildRoot
  VAST_FFMPEG_JOBS = $Jobs
}
$RepoRootMsys = "/$(($RepoRoot.Substring(0,1)).ToLower())/$($RepoRoot.Substring(3).Replace('\','/'))"
Invoke-Msys $Bash "'$RepoRootMsys/third_party/ffmpeg/scripts/build-vast-ffmpeg.sh'" $Environment

if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Recurse -Force }
New-Item -ItemType Directory -Path $Output -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $BuildRoot 'runtime') -Destination (Join-Path $Output 'runtime') -Recurse
Copy-Item -LiteralPath (Join-Path $BuildRoot 'ffmpeg-corresponding-source-win64.tar.zst') -Destination $Output

$versions = [ordered]@{}
foreach ($command in @(
  @{ key = 'gcc'; value = 'gcc -dumpfullversion' },
  @{ key = 'binutils'; value = 'ld --version' },
  @{ key = 'make'; value = 'make --version' },
  @{ key = 'nasm'; value = 'nasm -v' },
  @{ key = 'pkgconf'; value = 'pkgconf --version' }
)) {
  $value = & $Bash -lc "export PATH=/ucrt64/bin:/usr/bin:`$PATH; $($command.value)"
  if ($LASTEXITCODE -ne 0) { throw "Could not capture $($command.key) version." }
  $versionLines = @(@($value) | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_ })
  if ($versionLines.Count -eq 0) { throw "Could not capture $($command.key) version." }
  $versions[$command.key] = $versionLines[0]
}
$versions | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'toolchain-versions.json') -Encoding utf8
$Objdump = Join-Path $MsysRoot 'ucrt64/bin/objdump.exe'
$env:VAST_FFMPEG_OBJDUMP = $Objdump

$Ffmpeg = Join-Path $Output 'runtime/bin/ffmpeg.exe'
$Ffprobe = Join-Path $Output 'runtime/bin/ffprobe.exe'
$CapabilityReport = Join-Path $Output 'avidae-ffmpeg-capabilities.json'
& node (Join-Path $RepoRoot 'scripts/avidae-ffmpeg-capabilities.cjs') --ffmpeg $Ffmpeg --ffprobe $Ffprobe --output $CapabilityReport
if ($LASTEXITCODE -ne 0) { throw 'Vast FFmpeg failed the Avidae capability contract.' }
& node (Join-Path $RepoRoot 'scripts/generate-vast-ffmpeg-provenance.cjs') --root $Output
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg provenance generation failed.' }
& node (Join-Path $RepoRoot 'scripts/check-ffmpeg-release-compliance.cjs') --root $Output
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg compliance verification failed.' }

if ($env:GITHUB_ENV) {
  "VAST_AVIDAE_FFMPEG=$Ffmpeg" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  "VAST_AVIDAE_FFPROBE=$Ffprobe" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  "VAST_FFMPEG_BUILD_ROOT=$Output" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
Write-Host "Audited Vast FFmpeg runtime created at $Output"
