param([string] $EnvironmentFile = '')

. (Join-Path $PSScriptRoot 'common.ps1')
$revision = Read-VastChromiumRevision
$toolDirectory = Get-VastWindowsSdkX64Tools
$midl = Join-Path $toolDirectory 'midl.exe'
if (-not (Test-Path -LiteralPath $midl -PathType Leaf)) {
  throw "Pinned Windows SDK tools are missing. Run bootstrap-windows-sdk.ps1. Expected: $midl"
}

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

if (-not $EnvironmentFile) {
  $EnvironmentFile = Join-Path (Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)) 'environment.x64'
}
$EnvironmentFile = [System.IO.Path]::GetFullPath($EnvironmentFile)
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "Chromium x64 environment block is missing: $EnvironmentFile"
}

$text = [System.IO.File]::ReadAllText($EnvironmentFile)
$pairs = @($text.TrimEnd([char] 0).Split([char] 0))
$pathIndex = -1
for ($index = 0; $index -lt $pairs.Count; $index += 1) {
  if ($pairs[$index] -match '^PATH=') { $pathIndex = $index; break }
}
if ($pathIndex -lt 0) { throw "PATH is missing from Chromium environment block: $EnvironmentFile" }

$segments = @($pairs[$pathIndex].Substring(5).Split(';') | Where-Object {
  $_ -and -not $_.Equals($toolDirectory, [System.StringComparison]::OrdinalIgnoreCase)
})
$newSegments = @($toolDirectory) + $segments
$pairs[$pathIndex] = 'PATH=' + ($newSegments -join ';')
$updated = ($pairs -join [char] 0) + [char] 0 + [char] 0
[System.IO.File]::WriteAllText($EnvironmentFile, $updated, [System.Text.UTF8Encoding]::new($false))

Write-Host "Pinned SDK tools injected into: $EnvironmentFile"
Write-Host "MIDL: $midlVersion ($midlHash)"
