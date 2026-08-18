$ErrorActionPreference = 'Stop'
$portRoot = Split-Path -Parent $PSScriptRoot
$revision = Get-Content -LiteralPath (Join-Path $portRoot 'revision.json') -Raw | ConvertFrom-Json
$product = Get-Content -LiteralPath (Join-Path $portRoot 'product.json') -Raw | ConvertFrom-Json
$series = Get-Content -LiteralPath (Join-Path $portRoot 'patches\series.json') -Raw | ConvertFrom-Json
if ($revision.schemaVersion -ne 1) { throw 'revision schema mismatch' }
if ($revision.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'invalid Chromium version' }
if ($revision.commit -notmatch '^[0-9a-f]{40}$') { throw 'invalid Chromium commit' }
if ($revision.depotToolsCommit -notmatch '^[0-9a-f]{40}$') { throw 'invalid depot_tools commit' }
if ($revision.windowsSdk.servicingVersion -ne '10.0.26100.7705') { throw 'invalid Windows SDK pin' }
if ($revision.windowsSdk.isoUrl -notmatch '^https://download\.microsoft\.com/') { throw 'untrusted Windows SDK ISO URL' }
if ($revision.windowsSdk.isoSha256 -notmatch '^[0-9A-F]{64}$') { throw 'invalid Windows SDK ISO hash' }
if ($revision.windowsSdk.midlX64Sha256 -notmatch '^[0-9A-F]{64}$') { throw 'invalid MIDL hash' }
if ($revision.windowsSdk.cdbX64Sha256 -notmatch '^[0-9A-F]{64}$') { throw 'invalid CDB hash' }
if ($revision.sources.repository -notmatch '^https://chromium\.googlesource\.com/') { throw 'untrusted Chromium repository URL' }
if ($product.schemaVersion -ne 1 -or $product.version -ne '2.0.0-dev' -or $product.appId -ne 'app.vast.browser') { throw 'invalid Vast product metadata' }
if ($series.schemaVersion -ne 1 -or $null -eq $series.patches) { throw 'patch series schema mismatch' }
foreach ($entry in $series.patches) {
  if ($entry.file -notmatch '^\d{4}-[a-z0-9-]+\.patch$') { throw "invalid patch name: $($entry.file)" }
  if (-not (Test-Path -LiteralPath (Join-Path $portRoot "patches\$($entry.file)"))) { throw "missing patch: $($entry.file)" }
}
Write-Host 'PASS chromium-port metadata'
