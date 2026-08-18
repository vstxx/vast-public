$ErrorActionPreference = 'Stop'
$portRoot = Split-Path -Parent $PSScriptRoot
$report = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-preflight-test-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  & (Join-Path $portRoot 'scripts\preflight.ps1') -AllowIncomplete -ReportPath $report | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "preflight exited with $LASTEXITCODE" }
  $value = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
  if ($value.schemaVersion -ne 1 -or $null -eq $value.ready -or @($value.checks).Count -lt 10) {
    throw 'preflight report is incomplete'
  }
  Write-Host 'PASS chromium-port preflight report'
} finally {
  Remove-Item -LiteralPath $report -Force -ErrorAction SilentlyContinue
}
