param(
  [Parameter(Mandatory = $true)][string] $Source,
  [Parameter(Mandatory = $true)][string] $OutputDirectory,
  [switch] $VerifyOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$resolvedSource = (Resolve-Path -LiteralPath $Source).Path
if (-not $VerifyOnly) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
$sourceImage = [System.Drawing.Image]::FromFile($resolvedSource)

function Write-StoreAsset([string] $Name, [int] $Width, [int] $Height, [int] $IconSize) {
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $x = [int](($Width - $IconSize) / 2)
      $y = [int](($Height - $IconSize) / 2)
      $graphics.DrawImage($sourceImage, $x, $y, $IconSize, $IconSize)
    } finally {
      $graphics.Dispose()
    }
    $target = Join-Path $OutputDirectory $Name
    if ($VerifyOnly) {
      if (-not (Test-Path -LiteralPath $target)) { throw "Missing Store asset: $Name" }
      $actual = [System.Drawing.Bitmap]::FromFile($target)
      try {
        if ($actual.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid) { throw "Store asset is not a PNG: $Name" }
        $transparentPixels = 0
        $visiblePixels = 0
        if ($actual.Width -ne $Width -or $actual.Height -ne $Height) { throw "Invalid dimensions: $Name" }
        for ($row = 0; $row -lt $Height; $row++) {
          for ($column = 0; $column -lt $Width; $column++) {
            $alpha = $actual.GetPixel($column, $row).A
            if ($alpha -eq 0) { $transparentPixels++ }
            if ($alpha -gt 0) { $visiblePixels++ }
            if ($actual.GetPixel($column, $row).ToArgb() -ne $bitmap.GetPixel($column, $row).ToArgb()) {
              throw "Invalid Store asset pixels (logo, transparency or padding): $Name"
            }
          }
        }
        if ($Name -like '*altform-unplated*' -and ($transparentPixels -eq 0 -or $visiblePixels -eq 0)) {
          throw "Taskbar icon must contain the logo and fully transparent pixels: $Name"
        }
      } finally { $actual.Dispose() }
    } else {
      $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    }
  } finally {
    $bitmap.Dispose()
  }
}

try {
  Write-StoreAsset 'StoreLogo.png' 50 50 42
  Write-StoreAsset 'Square44x44Logo.png' 44 44 38
  Write-StoreAsset 'Square150x150Logo.png' 150 150 128
  Write-StoreAsset 'Wide310x150Logo.png' 310 150 128
  Write-StoreAsset 'Square310x310Logo.png' 310 310 264
  # Draw each taskbar resource directly from the original at its full target size.
  # Preserve the source alpha; do not downscale a padded tile or add a plate.
  foreach ($size in @(16, 20, 24, 30, 32, 36, 40, 44, 48, 60, 64, 72, 80, 96, 256)) {
    Write-StoreAsset "Square44x44Logo.targetsize-${size}_altform-unplated.png" $size $size $size
  }
} finally {
  $sourceImage.Dispose()
}
