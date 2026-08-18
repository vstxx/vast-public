$ErrorActionPreference = 'Stop'

$portRoot = Split-Path -Parent $PSScriptRoot
$patch = Get-Content -LiteralPath (Join-Path $portRoot 'patches\0001-vast-product-foundation.patch') -Raw

foreach ($required in @(
  'is_vast_branded',
  'PRODUCT_FULLNAME=Vast',
  'app.vast.browser',
  'VastHTM',
  'VastPDF',
  'direct_launch_url_scheme = "vast"',
  'VAST_BRANDING'
)) {
  if (-not $patch.Contains($required)) { throw "Missing Vast branding invariant: $required" }
}

$guidMatches = [regex]::Matches($patch, '\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}')
$productGuids = @($guidMatches | ForEach-Object { [guid]::Parse($_.Value.Trim('{}')) } | Select-Object -Unique)
if ($productGuids.Count -lt 1) { throw 'No parseable Vast product GUID was found.' }

$sidPrefix = 'S-1-15-2-1127763384-4260535648-3963402756-2560900623-2335563860-1726732036-'
$rendererSid = [System.Security.Principal.SecurityIdentifier]::new($sidPrefix + '129201922')
if ($rendererSid.Value -ne ($sidPrefix + '129201922')) { throw 'Vast renderer AppContainer SID is invalid.' }

Write-Host 'PASS Vast branding and Windows identity invariants'
