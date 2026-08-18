$ErrorActionPreference = 'Stop'
$portRoot = Split-Path -Parent $PSScriptRoot
$gen = Get-Content -LiteralPath (Join-Path $portRoot 'scripts\gen.ps1') -Raw
$smoke = Get-Content -LiteralPath (Join-Path $portRoot 'scripts\smoke-test.ps1') -Raw
$configurationScripts = Get-ChildItem (Join-Path $portRoot 'scripts') -File |
  Where-Object { $_.Name -notin @('smoke-test.ps1', 'build-report.ps1') } |
  Get-Content -Raw
$allPatches = Get-ChildItem (Join-Path $portRoot 'patches') -Filter '*.patch' -File | Get-Content -Raw
$joined = @($configurationScripts + $allPatches) -join [Environment]::NewLine

foreach ($forbidden in @(
  '--no-sandbox',
  '--disable-web-security',
  '--disable-site-isolation',
  '--ignore-certificate-errors',
  'google_default_client_secret',
  'google_default_client_id',
  'content_shell'
)) {
  if ($joined -match [regex]::Escape($forbidden)) { throw "forbidden Chromium configuration found: $forbidden" }
}
if ($gen -notmatch 'is_chrome_branded = false') { throw 'GN config must use open Chromium branding.' }
if ($gen -notmatch 'is_vast_branded = true') { throw 'GN config must enable the Vast product identity.' }
if ($joined -notmatch 'app\.vast\.browser') { throw 'The Chromium patch must declare an isolated Vast application identity.' }
if ($smoke -notmatch '--user-data-dir=') { throw 'Smoke test must use an explicit isolated profile.' }
if ($smoke -notmatch 'Electron runtime detected') { throw 'Smoke test must reject Electron identity.' }
if ($smoke -notmatch 'Vast%20Chromium%20Smoke') { throw 'Smoke data URL must not contain argument-splitting spaces.' }
foreach ($auditedFlag in @('--no-sandbox', '--disable-web-security', '--ignore-certificate-errors')) {
  if ($smoke -notmatch [regex]::Escape($auditedFlag)) { throw "Smoke test must audit $auditedFlag" }
}
Write-Host 'PASS Chromium port security configuration'
