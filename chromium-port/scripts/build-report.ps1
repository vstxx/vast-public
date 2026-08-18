param([string] $Executable, [string] $ReportPath)

. (Join-Path $PSScriptRoot 'common.ps1')
$src = Get-VastChromiumSrc
$out = Get-VastChromiumOut
$outPath = Join-Path $src $out
if (-not $Executable) {
  $Executable = if (Test-Path (Join-Path $outPath 'Vast.exe')) { Join-Path $outPath 'Vast.exe' } else { Join-Path $outPath 'chrome.exe' }
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Executable not found: $Executable" }
$revision = Read-VastChromiumRevision
$product = Get-Content -LiteralPath (Join-Path (Get-VastPortRoot) 'product.json') -Raw | ConvertFrom-Json
$actual = (& git -C $src rev-parse HEAD).Trim()
$argsPath = Join-Path $outPath 'args.gn'
$versionInfo = (Get-Item -LiteralPath $Executable).VersionInfo
$electronNamedFiles = @(Get-ChildItem -LiteralPath $outPath -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'electron|node\.dll' } | Select-Object -ExpandProperty Name)
$gnArgs = @($(
  if (Test-Path -LiteralPath $argsPath) {
    Get-Content -LiteralPath $argsPath | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_ }
  }
))
$forbiddenGnArgs = @($(
  $gnArgs | Where-Object {
      $_ -match '(?i)(no_sandbox|disable_web_security|ignore_certificate_errors|disable_site_isolation)'
  }
))
$report = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  productName = $product.productName
  appId = $product.appId
  productVersion = $product.version
  chromiumVersion = $revision.version
  pinnedCommit = $revision.commit
  actualCommit = $actual
  target = '//chrome:chrome'
  executable = [System.IO.Path]::GetFullPath($Executable)
  executableSha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
  executableProductName = $versionInfo.ProductName
  executableProductVersion = $versionInfo.ProductVersion
  executableFileVersion = $versionInfo.FileVersion
  gnArgs = $gnArgs
  electronNamedRuntimeFiles = $electronNamedFiles
  electronRuntimeAbsentByFileAudit = ($electronNamedFiles.Count -eq 0)
  forbiddenGnArgs = $forbiddenGnArgs
  securityBypassArgsAbsent = ($forbiddenGnArgs.Count -eq 0)
}
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'build' }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8
$report | ConvertTo-Json -Depth 5
Write-Host "Report: $ReportPath"
if ($actual -ne $revision.commit) { throw "Build commit mismatch: expected $($revision.commit), got $actual" }
if ($electronNamedFiles.Count -gt 0) { throw "Electron/Node-named runtime files found: $($electronNamedFiles -join ', ')" }
if ($forbiddenGnArgs.Count -gt 0) { throw "Forbidden GN security arguments found: $($forbiddenGnArgs -join ', ')" }
