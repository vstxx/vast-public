param(
  [Parameter(Mandatory = $true)]
  [string] $ArchivePath,
  [Parameter(Mandatory = $true)]
  [string] $Version
)

$ErrorActionPreference = 'Stop'
$ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  [long] $uncompressedBytes = 0
  [int] $fileCount = 0
  foreach ($entry in $archive.Entries) {
    $rawName = [string] $entry.FullName
    if ([string]::IsNullOrWhiteSpace($rawName)) { throw 'Update ZIP contains an unnamed entry.' }
    if ($rawName.Contains('\') -and $rawName.Contains('/')) { throw "Update ZIP mixes path separators: $rawName" }
    $name = $rawName.Replace('\', '/')
    if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:') { throw "Update ZIP contains an unsafe path: $name" }
    $segments = @($name.Split('/') | Where-Object { $_ -ne '' })
    if ($segments | Where-Object { $_ -eq '.' -or $_ -eq '..' }) { throw "Update ZIP contains path traversal: $name" }
    if (-not $seen.Add($name)) { throw "Update ZIP contains a duplicate path: $name" }
    if ($name.EndsWith('/')) { continue }
    [void] $names.Add($name)
    $fileCount += 1
    $uncompressedBytes += $entry.Length
  }

  $required = @(
    'Updater/VastUpdater.ps1',
    'Updater/updater.config.json',
    "Vast-$Version/win-unpacked/Vast.exe",
    "Vast-$Version/win-unpacked/resources/app.asar",
    "Vast-$Version/win-unpacked/resources/app-update.yml",
    "Vast-$Version/win-unpacked/resources/avidae-runtime/runtime-manifest.json"
  )
  foreach ($requiredPath in $required) {
    if (-not $names.Contains($requiredPath)) { throw "Update ZIP is missing required entry: $requiredPath" }
  }
  foreach ($name in $names) {
    if ($name -match '(?i)(?:^|/)Vast-Setup-[^/]+\.exe$' -or $name -match '(?i)-Portable\.exe$' -or $name -match '(?i)-update\.zip$') {
      throw "Update ZIP embeds an unrelated distribution artifact: $name"
    }
  }

  [pscustomobject]@{
    ok = $true
    archive = $ArchivePath
    fileCount = $fileCount
    uncompressedBytes = $uncompressedBytes
    requiredEntries = $required
  } | ConvertTo-Json -Depth 4 -Compress
} finally {
  $archive.Dispose()
}
