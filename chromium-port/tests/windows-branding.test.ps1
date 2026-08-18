$ErrorActionPreference = 'Stop'
$portRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-branding-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  & (Join-Path $portRoot 'scripts\generate-windows-branding.ps1') -Destination $tempRoot
  $iconPath = Join-Path $tempRoot 'vast.ico'
  $bytes = [System.IO.File]::ReadAllBytes($iconPath)
  if ([BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
    throw 'Generated Vast icon has an invalid ICO header.'
  }
  $count = [BitConverter]::ToUInt16($bytes, 4)
  if ($count -ne 4) { throw "Generated Vast icon has $count frames instead of 4." }
  $actualSizes = for ($index = 0; $index -lt $count; $index += 1) {
    $width = $bytes[6 + (16 * $index)]
    if ($width -eq 0) { 256 } else { [int]$width }
  }
  if (($actualSizes -join ',') -ne '16,32,48,256') {
    throw "Generated Vast icon has unexpected sizes: $($actualSizes -join ',')"
  }
  foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $pngPath = Join-Path $tempRoot "product_logo_$size.png"
    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($pngPath)
    try {
      if ($image.Width -ne $size -or $image.Height -ne $size) {
        throw "Generated PNG has the wrong dimensions: $pngPath"
      }
    } finally {
      $image.Dispose()
    }
  }
  Write-Host 'PASS Vast Windows branding asset generation'
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
