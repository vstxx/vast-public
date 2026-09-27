[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RootSubject = 'CN=Vast Password Manager Gate Root'
$LeafSubject = 'CN=login.vast-test.local'
$DnsNames = @(
  'login.vast-test.local',
  'spa.vast-test.local',
  'dynamic.vast-test.local',
  'iframe.vast-test.local'
)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$MetadataPath = Join-Path $OutputDirectory 'metadata.json'
$PfxPath = Join-Path $OutputDirectory 'leaf.pfx'
$PassphrasePath = Join-Path $OutputDirectory 'leaf.passphrase'
$RootCertificatePath = Join-Path $OutputDirectory 'root.cer'

function Get-ExactCertificate {
  param([string]$StorePath, [string]$Thumbprint)
  @(Get-ChildItem -LiteralPath $StorePath | Where-Object { $_.Thumbprint -eq $Thumbprint })
}

function Get-DnsNames {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
  @($Certificate.DnsNameList | ForEach-Object { $_.Unicode })
}

function Test-ExactNames {
  param([string[]]$Actual, [string[]]$Expected)
  if ($Actual.Count -ne $Expected.Count) { return $false }
  $actualSorted = @($Actual | Sort-Object)
  $expectedSorted = @($Expected | Sort-Object)
  for ($index = 0; $index -lt $expectedSorted.Count; $index += 1) {
    if ($actualSorted[$index] -cne $expectedSorted[$index]) { return $false }
  }
  return $true
}

function Protect-CurrentUserFile {
  param([string]$Path)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $identity.User,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-PrivateFileAcl {
  param([string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rules = @((Get-Acl -LiteralPath $Path).Access)
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) {
    throw "Private TLS file ACL is not current-user-only: $Path"
  }
}

function Write-PublicResult {
  param($Metadata)
  [pscustomobject]@{
    rootThumbprint = $Metadata.rootThumbprint
    leafThumbprint = $Metadata.leafThumbprint
    dnsNames = @($Metadata.dnsNames)
    expiresAt = $Metadata.expiresAt
  } | ConvertTo-Json -Depth 3
}

if (Test-Path -LiteralPath $MetadataPath) {
  $metadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
  if ($metadata.schemaVersion -ne 1 -or $metadata.rootSubject -cne $RootSubject -or $metadata.leafSubject -cne $LeafSubject) {
    throw 'Existing TLS metadata has an unexpected schema or subject; refusing to replace it.'
  }
  if (-not (Test-ExactNames @($metadata.dnsNames) $DnsNames)) {
    throw 'Existing TLS metadata has an unexpected SAN list; refusing to replace it.'
  }
  $rootMatches = @(Get-ExactCertificate 'Cert:\CurrentUser\Root' $metadata.rootThumbprint)
  $leafMatches = @(Get-ExactCertificate 'Cert:\CurrentUser\My' $metadata.leafThumbprint)
  if ($rootMatches.Count -ne 1 -or $rootMatches[0].Subject -cne $RootSubject) {
    throw 'Existing TLS root thumbprint or subject does not match the CurrentUser trust store.'
  }
  if ($leafMatches.Count -ne 1 -or $leafMatches[0].Subject -cne $LeafSubject) {
    throw 'Existing TLS leaf thumbprint or subject does not match the CurrentUser personal store.'
  }
  if (-not (Test-ExactNames (Get-DnsNames $leafMatches[0]) $DnsNames)) {
    throw 'Existing TLS leaf SANs do not match the approved fixture names.'
  }
  if ($leafMatches[0].NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow.AddDays(7)) {
    throw 'Existing TLS leaf expires in less than seven days.'
  }
  foreach ($privatePath in @($PfxPath, $PassphrasePath)) {
    if (-not (Test-Path -LiteralPath $privatePath -PathType Leaf)) { throw "Existing TLS private file is missing: $privatePath" }
    Assert-PrivateFileAcl $privatePath
  }
  $savedPassphrase = (Get-Content -Raw -LiteralPath $PassphrasePath).Trim()
  $savedCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $PfxPath,
    $savedPassphrase,
    [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  )
  if ($savedCertificate.Thumbprint -ne $metadata.leafThumbprint) {
    throw 'Existing PFX does not contain the metadata-bound leaf certificate.'
  }
  Write-PublicResult $metadata
  exit 0
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (@(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\Root' | Where-Object Subject -EQ $RootSubject).Count -gt 0 -or
    @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' | Where-Object { $_.Subject -eq $RootSubject -or $_.Subject -eq $LeafSubject }).Count -gt 0) {
  throw 'A certificate with a gate subject already exists without matching metadata; refusing to adopt or replace it.'
}

$root = $null
$leaf = $null
$rootImported = $false
try {
  $root = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $RootSubject `
    -FriendlyName 'Vast Password Manager Gate Root' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -KeyUsage CertSign,CRLSign,DigitalSignature `
    -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') `
    -NotAfter ([DateTime]::UtcNow.AddYears(5))

  $leaf = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $LeafSubject `
    -FriendlyName 'Vast Password Manager Gate TLS' `
    -DnsName $DnsNames `
    -Signer $root `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature,KeyEncipherment `
    -TextExtension @('2.5.29.19={critical}{text}ca=0', '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
    -NotAfter ([DateTime]::UtcNow.AddYears(2))

  Export-Certificate -Cert $root -FilePath $RootCertificatePath -Force | Out-Null
  $trustedRoot = Import-Certificate -FilePath $RootCertificatePath -CertStoreLocation 'Cert:\CurrentUser\Root'
  if ($trustedRoot.Thumbprint -ne $root.Thumbprint) { throw 'Imported root thumbprint mismatch.' }
  $rootImported = $true

  $secretBytes = [byte[]]::new(32)
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($secretBytes)
  } finally {
    $random.Dispose()
  }
  $passphrase = [Convert]::ToBase64String($secretBytes)
  $securePassphrase = ConvertTo-SecureString -String $passphrase -AsPlainText -Force
  Export-PfxCertificate -Cert $leaf -FilePath $PfxPath -Password $securePassphrase -ChainOption EndEntityCertOnly -NoProperties -Force | Out-Null
  [IO.File]::WriteAllText($PassphrasePath, $passphrase, [Text.UTF8Encoding]::new($false))
  Protect-CurrentUserFile $PfxPath
  Protect-CurrentUserFile $PassphrasePath
  Assert-PrivateFileAcl $PfxPath
  Assert-PrivateFileAcl $PassphrasePath

  $metadata = [ordered]@{
    schemaVersion = 1
    rootSubject = $RootSubject
    leafSubject = $LeafSubject
    rootThumbprint = $root.Thumbprint
    leafThumbprint = $leaf.Thumbprint
    dnsNames = $DnsNames
    expiresAt = $leaf.NotAfter.ToUniversalTime().ToString('o')
    pfxFile = 'leaf.pfx'
    passphraseFile = 'leaf.passphrase'
  }
  [IO.File]::WriteAllText($MetadataPath, (($metadata | ConvertTo-Json -Depth 3) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Write-PublicResult $metadata
} catch {
  if ($leaf) { Remove-Item -LiteralPath $leaf.PSPath -Force -ErrorAction SilentlyContinue }
  if ($rootImported -and $root) {
    Get-ExactCertificate 'Cert:\CurrentUser\Root' $root.Thumbprint | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Force }
  }
  foreach ($file in @($MetadataPath, $PfxPath, $PassphrasePath, $RootCertificatePath)) {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if ($root) { Remove-Item -LiteralPath $root.PSPath -Force -ErrorAction SilentlyContinue }
}
