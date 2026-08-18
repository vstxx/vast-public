$ErrorActionPreference = 'Stop'

$portRoot = Split-Path -Parent $PSScriptRoot
$files = @(
  Get-ChildItem -LiteralPath (Join-Path $portRoot 'scripts') -Filter '*.ps1' -File
  Get-ChildItem -LiteralPath (Join-Path $portRoot 'tests') -Filter '*.ps1' -File
)

foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $file.FullName,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    $messages = @($errors | ForEach-Object { $_.Message }) -join '; '
    throw "$($file.Name) has PowerShell parser errors: $messages"
  }
}

Write-Host "PASS PowerShell parser ($($files.Count) files)"
