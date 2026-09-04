param(
  [Parameter(Mandatory = $true)][string] $Source,
  [Parameter(Mandatory = $true)][string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$resolvedSource = (Resolve-Path -LiteralPath $Source).Path
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
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
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
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
} finally {
  $sourceImage.Dispose()
}
