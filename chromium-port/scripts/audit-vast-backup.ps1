param(
  [Parameter(Mandatory = $true)]
  [string] $BackupPath,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

$BackupPath = [System.IO.Path]::GetFullPath($BackupPath)
$file = Get-Item -LiteralPath $BackupPath -ErrorAction Stop
if ($file.Length -gt 512MB) { throw 'Backup exceeds the 512 MB archive limit.' }

$archive = [System.IO.Compression.ZipFile]::OpenRead($BackupPath)
try {
  if ($archive.Entries.Count -gt 10000) { throw 'Backup contains too many entries.' }
  $entries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
  [int64] $totalBytes = 0
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if (
      [System.IO.Path]::IsPathRooted($name) -or
      $name.StartsWith('/') -or
      @($name.Split('/')) -contains '..' -or
      $entries.ContainsKey($name)
    ) {
      throw "Backup contains an unsafe or duplicate archive path."
    }
    $entries.Add($name, $entry)
    $totalBytes += $entry.Length
    if ($entry.Length -gt 256MB -or $totalBytes -gt 2GB) { throw 'Backup exceeds uncompressed data limits.' }
  }

  if (-not $entries.ContainsKey('manifest.json')) { throw 'Backup manifest is missing.' }
  $manifestEntry = $entries['manifest.json']
  # Large full-profile backups can legitimately contain thousands of checksum
  # records; keep this bounded but compatible with the v1 writer's 10k entries.
  if ($manifestEntry.Length -gt 16MB) { throw 'Backup manifest is too large.' }
  $reader = [System.IO.StreamReader]::new($manifestEntry.Open(), [System.Text.Encoding]::UTF8, $true)
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }

  if (
    $manifest.product -ne 'Vast' -or
    $manifest.exportFormatVersion -ne 1 -or
    $manifest.vastDataIncluded -ne $true -or
    -not $manifest.checksums
  ) {
    throw 'Backup manifest is incompatible or incomplete.'
  }

  $checksumProperties = @($manifest.checksums.PSObject.Properties)
  if ($checksumProperties.Count -ne [int]$manifest.includedFileCount) {
    throw 'Backup manifest file count does not match its checksums.'
  }
  if (-not ($checksumProperties.Name -contains 'data/vast-data.json')) {
    throw 'Backup does not contain the required Vast profile JSON.'
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    foreach ($property in $checksumProperties) {
      $path = $property.Name.Replace('\', '/')
      if (-not $entries.ContainsKey($path)) { throw 'A checksummed backup entry is missing.' }
      $entry = $entries[$path]
      $expected = $property.Value
      if ([int64]$expected.sizeBytes -ne $entry.Length) { throw 'A backup entry size does not match its manifest.' }
      $stream = $entry.Open()
      try { $digest = $sha.ComputeHash($stream) } finally { $stream.Dispose() }
      $actual = ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
      if ($actual -ne ([string]$expected.sha256).ToLowerInvariant()) { throw 'A backup entry checksum is invalid.' }
      $sha.Initialize()
    }
  } finally {
    $sha.Dispose()
  }

  $report = [ordered]@{
    schemaVersion = 1
    auditedAt = (Get-Date).ToUniversalTime().ToString('o')
    archiveSha256 = (Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256).Hash.ToLowerInvariant()
    archiveSizeBytes = $file.Length
    product = $manifest.product
    appId = $manifest.appId
    appVersion = $manifest.appVersion
    exportFormatVersion = $manifest.exportFormatVersion
    createdAt = $manifest.createdAt
    includedFileCount = $manifest.includedFileCount
    skippedFileCount = $manifest.skippedFileCount
    includedSections = @($manifest.includedSections)
    vastDataIncluded = $manifest.vastDataIncluded
    passwordVaultIncluded = $manifest.passwordVaultIncluded
    checksumsValid = $true
    sourceDataPathRedacted = $true
    warnings = @($manifest.warnings)
  }
  if (-not $ReportPath) { $ReportPath = New-VastReportPath 'backup-audit' }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  $report | ConvertTo-Json -Depth 5
  Write-Host "PASS backup structure and checksums; report: $ReportPath"
} finally {
  $archive.Dispose()
}
