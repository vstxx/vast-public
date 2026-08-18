$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$portRoot = Split-Path -Parent $PSScriptRoot
$auditScript = Join-Path $portRoot 'scripts\audit-vast-backup.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-backup-audit-test-" + [guid]::NewGuid().ToString('N'))
$backupPath = Join-Path $tempRoot 'fixture.vastbackup'
$reportPath = Join-Path $tempRoot 'report.json'

function Add-ZipText(
  [System.IO.Compression.ZipArchive] $Archive,
  [string] $Path,
  [string] $Text
) {
  $entry = $Archive.CreateEntry($Path, [System.IO.Compression.CompressionLevel]::Optimal)
  $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
  try { $writer.Write($Text) } finally { $writer.Dispose() }
}

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $profileJson = '{"schemaVersion":5}'
  $profileBytes = [System.Text.Encoding]::UTF8.GetBytes($profileJson)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash($profileBytes) } finally { $sha.Dispose() }
  $profileSha = ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
  $manifest = [ordered]@{
    product = 'Vast'
    appId = 'app.vast.browser'
    appVersion = '1.0.11'
    exportFormatVersion = 1
    createdAt = '2026-07-15T00:00:00Z'
    includedFileCount = 1
    skippedFileCount = 0
    includedSections = @('Vast profile JSON')
    vastDataIncluded = $true
    passwordVaultIncluded = $false
    checksums = [ordered]@{
      'data/vast-data.json' = [ordered]@{
        sizeBytes = $profileBytes.Length
        sha256 = $profileSha
      }
    }
    warnings = @()
  }

  $archive = [System.IO.Compression.ZipFile]::Open($backupPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Add-ZipText $archive 'data/vast-data.json' $profileJson
    Add-ZipText $archive 'manifest.json' ($manifest | ConvertTo-Json -Depth 8)
  } finally {
    $archive.Dispose()
  }

  & $auditScript -BackupPath $backupPath -ReportPath $reportPath | Out-Null
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if (
    -not $report.checksumsValid -or
    -not $report.sourceDataPathRedacted -or
    $report.includedFileCount -ne 1 -or
    $report.PSObject.Properties.Name -contains 'sourceDataPath'
  ) {
    throw 'Valid backup audit report did not satisfy its safety contract.'
  }

  Write-Host 'PASS Vast backup read-only audit fixture'
} finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
