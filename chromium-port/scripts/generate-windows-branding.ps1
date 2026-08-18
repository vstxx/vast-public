param([string] $Destination)

. (Join-Path $PSScriptRoot 'common.ps1')

Add-Type -AssemblyName System.Drawing

if (-not $Destination) {
  $Destination = Join-Path (Get-VastPortRoot) '.generated\windows-branding'
}
$Destination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

$sourcePath = Join-Path (Get-VastRepositoryRoot) 'assets\logos\vasticon.png'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Vast source logo is missing: $sourcePath"
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngFrames = [ordered]@{}
$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
    throw "Vast source logo must be square and at least 256 px: $sourcePath"
  }

  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }
      $pngPath = Join-Path $Destination "product_logo_$size.png"
      $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $pngFrames[$size.ToString()] = [System.IO.File]::ReadAllBytes($pngPath)
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $source.Dispose()
}

$iconSizes = @(16, 32, 48, 256)
$iconPath = Join-Path $Destination 'vast.ico'
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$iconSizes.Count)
  $offset = 6 + (16 * $iconSizes.Count)
  foreach ($size in $iconSizes) {
    $frame = [byte[]]$pngFrames[$size.ToString()]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$frame.Length)
    $writer.Write([uint32]$offset)
    $offset += $frame.Length
  }
  foreach ($size in $iconSizes) {
    $writer.Write([byte[]]$pngFrames[$size.ToString()])
  }
  $writer.Flush()
  [System.IO.File]::WriteAllBytes($iconPath, $stream.ToArray())
} finally {
  $writer.Dispose()
  $stream.Dispose()
}

Write-Host "Generated Vast Windows branding assets: $Destination"
