param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [switch]$ReportOnly
)

$ErrorActionPreference = 'Stop'

# GitHub Actions runs release steps in PowerShell 7, then invokes this script
# with Windows PowerShell for Authenticode. PSModulePath can still point at the
# PowerShell 7 module tree, which makes Windows PowerShell find an incompatible
# Microsoft.PowerShell.Security module. Import the module shipped with the
# current host explicitly so the recursive PE audit never depends on inherited
# shell state.
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $securityModule -PathType Leaf)) {
  throw "The Authenticode security module is unavailable for this PowerShell host: $securityModule"
}
Import-Module -Name $securityModule -Force -ErrorAction Stop
if (-not (Get-Command -Name Get-AuthenticodeSignature -CommandType Cmdlet -ErrorAction SilentlyContinue)) {
  throw 'Get-AuthenticodeSignature is unavailable after loading Microsoft.PowerShell.Security.'
}

function Test-PortableExecutable {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($stream.Length -lt 64) { return $false }
    $reader = New-Object System.IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { return $false }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 4)) { return $false }
    $stream.Position = $peOffset
    return $reader.ReadUInt32() -eq 0x00004550
  } catch {
    throw "Could not inspect candidate binary '$Path': $($_.Exception.Message)"
  } finally {
    if ($reader) { $reader.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
}

$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
$relativeRoot = $resolvedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$portableExecutables = @(
  Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force |
    Where-Object { Test-PortableExecutable -Path $_.FullName }
)

if ($portableExecutables.Count -eq 0) {
  throw "No Portable Executable files were found under $resolvedRoot"
}

$results = foreach ($file in $portableExecutables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $relativePath = $file.FullName.Substring($relativeRoot.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  [pscustomobject]@{
    path = $relativePath.Replace('\\', '/')
    status = [string]$signature.Status
    signer = [string]$signature.SignerCertificate.Subject
    thumbprint = [string]$signature.SignerCertificate.Thumbprint
    timestampSigner = [string]$signature.TimeStamperCertificate.Subject
    valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
  }
}

$failures = @($results | Where-Object { -not $_.valid })
$report = [ordered]@{
  ok = $ReportOnly -or $failures.Count -eq 0
  mode = $(if ($ReportOnly) { 'inventory' } else { 'signature-gate' })
  root = $resolvedRoot
  peCount = $results.Count
  validCount = @($results | Where-Object valid).Count
  failureCount = $failures.Count
  failures = $failures
  files = $results
}

$report | ConvertTo-Json -Depth 6 -Compress

if (-not $ReportOnly -and $failures.Count -gt 0) {
  Write-Error ("Recursive PE Authenticode audit failed for {0} file(s)." -f $failures.Count)
  exit 1
}
