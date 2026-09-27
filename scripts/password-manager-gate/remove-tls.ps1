[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedRootSubject = 'CN=Vast Password Manager Gate Root'
$ExpectedLeafSubject = 'CN=login.vast-test.local'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$MetadataPath = Join-Path $OutputDirectory 'metadata.json'
if (-not (Test-Path -LiteralPath $MetadataPath -PathType Leaf)) {
  throw "TLS metadata is missing; refusing unbound certificate cleanup: $MetadataPath"
}

$metadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
if ($metadata.schemaVersion -ne 1 -or
    $metadata.rootSubject -cne $ExpectedRootSubject -or
    $metadata.leafSubject -cne $ExpectedLeafSubject -or
    $metadata.rootThumbprint -notmatch '^[A-F0-9]{40}$' -or
    $metadata.leafThumbprint -notmatch '^[A-F0-9]{40}$') {
  throw 'TLS metadata does not match the gate certificate policy; refusing cleanup.'
}

$rootMatches = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\Root' | Where-Object { $_.Thumbprint -eq $metadata.rootThumbprint })
$leafMatches = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' | Where-Object { $_.Thumbprint -eq $metadata.leafThumbprint })
if ($rootMatches.Count -ne 1 -or $rootMatches[0].Subject -cne $ExpectedRootSubject) {
  throw 'Metadata-bound root certificate is missing or has a mismatched subject; refusing cleanup.'
}
if ($leafMatches.Count -ne 1 -or $leafMatches[0].Subject -cne $ExpectedLeafSubject) {
  throw 'Metadata-bound leaf certificate is missing or has a mismatched subject; refusing cleanup.'
}

Remove-Item -LiteralPath $leafMatches[0].PSPath -Force
Remove-Item -LiteralPath $rootMatches[0].PSPath -Force

if ($RemoveFiles) {
  foreach ($name in @($metadata.pfxFile, $metadata.passphraseFile, 'root.cer', 'metadata.json')) {
    if ([string]::IsNullOrWhiteSpace($name) -or [IO.Path]::GetFileName($name) -cne $name) {
      throw 'TLS metadata contains an unsafe file name; certificates were removed but files were preserved.'
    }
    Remove-Item -LiteralPath (Join-Path $OutputDirectory $name) -Force -ErrorAction SilentlyContinue
  }
}

[pscustomobject]@{
  removedRootThumbprint = $metadata.rootThumbprint
  removedLeafThumbprint = $metadata.leafThumbprint
  filesRemoved = [bool]$RemoveFiles
} | ConvertTo-Json
