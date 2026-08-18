$ErrorActionPreference = 'Stop'

$tests = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.test.ps1' -File | Sort-Object Name
foreach ($test in $tests) {
  Write-Host "RUN $($test.Name)"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $test.FullName
  if ($LASTEXITCODE -ne 0) { throw "$($test.Name) failed with exit code $LASTEXITCODE." }
}

$pythonTest = Join-Path $PSScriptRoot 'test_extract_gitiles_archive.py'
& python.exe -m unittest $pythonTest
if ($LASTEXITCODE -ne 0) { throw 'Python archive extraction tests failed.' }

Write-Host "PASS Chromium port test suite ($($tests.Count) PowerShell files plus Python)"
