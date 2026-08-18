param(
  [string] $DestinationRoot = '',
  [string] $DownloadDirectory = ''
)

. (Join-Path $PSScriptRoot 'common.ps1')
$revision = Read-VastChromiumRevision
$src = Get-VastChromiumSrc
$chromiumRoot = Split-Path -Parent $src
if (-not $DestinationRoot) {
  $DestinationRoot = Split-Path -Parent (Split-Path -Parent (Get-VastWindowsSdkRoot))
}
if (-not $DownloadDirectory) { $DownloadDirectory = Join-Path $chromiumRoot 'installers' }
$DestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$DownloadDirectory = [System.IO.Path]::GetFullPath($DownloadDirectory)
Assert-VastShortPath $DestinationRoot 'Windows SDK extraction root'
Assert-VastShortPath $DownloadDirectory 'Windows SDK download directory'
New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null

$isoPath = Join-Path $DownloadDirectory "WindowsSDK-$($revision.windowsSdk.servicingVersion).iso"
if (-not (Test-Path -LiteralPath $isoPath -PathType Leaf)) {
  Write-Host "Downloading the pinned Microsoft Windows SDK ISO (about 1.1 GB)..."
  Invoke-VastNative 'curl.exe' @(
    '-L', '--fail', '--retry', '5', '--retry-delay', '2', '-C', '-',
    '-o', $isoPath, $revision.windowsSdk.isoUrl
  )
}

$isoHash = (Get-FileHash -LiteralPath $isoPath -Algorithm SHA256).Hash
if ($isoHash -ne $revision.windowsSdk.isoSha256) {
  throw "Windows SDK ISO hash mismatch: expected $($revision.windowsSdk.isoSha256), got $isoHash"
}

$image = Get-DiskImage -ImagePath $isoPath -ErrorAction SilentlyContinue
$mountedHere = -not ($image -and $image.Attached)
if ($mountedHere) { $image = Mount-DiskImage -ImagePath $isoPath -PassThru }
try {
  $volume = $image | Get-Volume
  if (-not $volume.DriveLetter) { throw "Mounted SDK ISO has no drive letter: $isoPath" }
  $installerRoot = "$($volume.DriveLetter):\Installers"
  $packages = @(
    'Windows SDK Desktop Tools x64-x86_en-us.msi',
    'Windows SDK for Windows Store Apps Tools-x86_en-us.msi',
    'SDK Debuggers-x86_en-us.msi',
    'X64 Debuggers And Tools-x64_en-us.msi'
  )
  foreach ($package in $packages) {
    $msi = Join-Path $installerRoot $package
    if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw "SDK package not found: $msi" }
    $logName = ($package -replace '[^A-Za-z0-9.-]', '_') + '.log'
    $log = Join-Path $DownloadDirectory $logName
    $arguments = @(
      '/a', ('"' + $msi + '"'),
      ('TARGETDIR="' + $DestinationRoot + '"'),
      '/qn', '/norestart', '/l*v', ('"' + $log + '"')
    )
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments `
      -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) {
      throw "Administrative extraction failed for $package with exit code $($process.ExitCode). Log: $log"
    }
  }
} finally {
  if ($mountedHere) { Dismount-DiskImage -ImagePath $isoPath | Out-Null }
}

$midl = Join-Path $DestinationRoot "Windows Kits\10\bin\$($revision.windowsSdk.folderVersion)\x64\midl.exe"
if (-not (Test-Path -LiteralPath $midl -PathType Leaf)) { throw "Extracted MIDL is missing: $midl" }
$midlHash = (Get-FileHash -LiteralPath $midl -Algorithm SHA256).Hash
$midlVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($midl).FileVersion
$signature = Get-AuthenticodeSignature -LiteralPath $midl
if ($midlHash -ne $revision.windowsSdk.midlX64Sha256) {
  throw "MIDL hash mismatch: expected $($revision.windowsSdk.midlX64Sha256), got $midlHash"
}
if ($midlVersion -notlike "$($revision.windowsSdk.servicingVersion)*") {
  throw "MIDL version mismatch: expected $($revision.windowsSdk.servicingVersion), got $midlVersion"
}
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation') {
  throw "MIDL Authenticode validation failed: $($signature.Status)"
}

$cdb = Join-Path $DestinationRoot 'Windows Kits\10\Debuggers\x64\cdb.exe'
if (-not (Test-Path -LiteralPath $cdb -PathType Leaf)) { throw "Extracted CDB is missing: $cdb" }
$cdbHash = (Get-FileHash -LiteralPath $cdb -Algorithm SHA256).Hash
$cdbVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($cdb).FileVersion
$cdbSignature = Get-AuthenticodeSignature -LiteralPath $cdb
if ($cdbHash -ne $revision.windowsSdk.cdbX64Sha256) {
  throw "CDB hash mismatch: expected $($revision.windowsSdk.cdbX64Sha256), got $cdbHash"
}
if ($cdbVersion -notlike "$($revision.windowsSdk.servicingVersion)*") {
  throw "CDB version mismatch: expected $($revision.windowsSdk.servicingVersion), got $cdbVersion"
}
if ($cdbSignature.Status -ne 'Valid' -or $cdbSignature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation') {
  throw "CDB Authenticode validation failed: $($cdbSignature.Status)"
}

Write-Host "Pinned Windows SDK tools ready: $DestinationRoot"
Write-Host "MIDL: $midlVersion ($midlHash)"
Write-Host "CDB: $cdbVersion ($cdbHash)"
