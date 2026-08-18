param(
  [switch] $Rebaseline,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-VastDepotEnvironment
$src = Get-VastChromiumSrc
$out = Get-VastChromiumOut
$outPath = Join-Path $src $out
if (-not (Test-Path -LiteralPath (Join-Path $outPath 'environment.x64') -PathType Leaf)) {
  throw 'GN x64 environment is missing. Run gen.ps1 first.'
}
& (Join-Path $PSScriptRoot 'pin-sdk-tools.ps1') -EnvironmentFile (Join-Path $outPath 'environment.x64')

$targets = @(
  'chrome/elevation_service:elevation_service_idl_idl_action',
  'chrome/updater/app/server/win:updater_idl_idl_action',
  'chrome/updater/app/server/win:updater_internal_idl_idl_action',
  'chrome/updater/app/server/win:updater_legacy_idl_idl_action',
  'chrome/windows_services/elevated_tracing_service:tracing_service_idl_idl_action',
  'third_party/iaccessible2:iaccessible2_idl_action',
  'third_party/isimpledom:isimpledom_idl_action',
  'ui/accessibility/platform:ichromeaccessible_idl_action'
)
$baselineRoot = [System.IO.Path]::GetFullPath((Join-Path $src 'third_party\win_build_output\midl'))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$results = [System.Collections.Generic.List[object]]::new()
$mismatchCount = 0
$env:NINJA_SUMMARIZE_BUILD = '0'

foreach ($target in $targets) {
  Write-Host "Verify public MIDL target: $target"
  $output = @(& autoninja.bat -C $out $target -j 1 2>&1)
  $exitCode = $LASTEXITCODE
  $output | Out-Host
  if ($exitCode -eq 0) {
    $results.Add([pscustomobject]@{ target = $target; state = 'match'; files = @() })
    continue
  }

  $copyLine = [string]($output | Where-Object { $_ -match '^\s*copy /y .+\\\* .+$' } | Select-Object -Last 1)
  if (-not $copyLine -or $copyLine -notmatch '^\s*copy /y (.+)\\\* (.+)$') {
    throw "MIDL target failed without Chromium's expected rebaseline instruction: $target"
  }
  $generatedDirectory = [System.IO.Path]::GetFullPath($matches[1].Trim())
  $baselineDirectory = [System.IO.Path]::GetFullPath((Join-Path $outPath $matches[2].Trim()))
  if (-not $generatedDirectory.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing generated files outside the temporary directory: $generatedDirectory"
  }
  if (-not $baselineDirectory.StartsWith($baselineRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing baseline update outside Chromium MIDL output: $baselineDirectory"
  }

  $changes = [System.Collections.Generic.List[object]]::new()
  foreach ($generated in Get-ChildItem -LiteralPath $generatedDirectory -File) {
    $baseline = Join-Path $baselineDirectory $generated.Name
    if (-not (Test-Path -LiteralPath $baseline -PathType Leaf)) {
      throw "Refusing new MIDL baseline file not already present upstream: $baseline"
    }
    $beforeHash = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash
    $afterHash = (Get-FileHash -LiteralPath $generated.FullName -Algorithm SHA256).Hash
    if ($beforeHash -eq $afterHash) { continue }
    if ($generated.Extension -ne '.tlb') {
      throw "Public SDK changed non-TLB MIDL output; manual review required: $($generated.Name)"
    }
    if ((Get-Item -LiteralPath $baseline).Length -ne $generated.Length) {
      throw "Public SDK changed TLB length; manual review required: $($generated.Name)"
    }
    $changes.Add([pscustomobject]@{
      file = $baseline
      beforeSha256 = $beforeHash
      afterSha256 = $afterHash
      length = $generated.Length
    })
    if ($Rebaseline) { Copy-Item -LiteralPath $generated.FullName -Destination $baseline -Force }
  }
  if ($changes.Count -eq 0) { throw "MIDL reported a mismatch but no reviewed TLB delta was found: $target" }
  if (-not $Rebaseline) {
    $mismatchCount += 1
    $results.Add([pscustomobject]@{ target = $target; state = 'tlb-mismatch'; files = @($changes) })
    continue
  }

  $verifyOutput = @(& autoninja.bat -C $out $target -j 1 2>&1)
  $verifyExitCode = $LASTEXITCODE
  $verifyOutput | Out-Host
  if ($verifyExitCode -ne 0) { throw "Rebaselined MIDL target still fails: $target" }
  $results.Add([pscustomobject]@{ target = $target; state = 'rebaselined-and-verified'; files = @($changes) })
}

$report = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  sdkVersion = (Read-VastChromiumRevision).windowsSdk.servicingVersion
  rebaselineEnabled = [bool]$Rebaseline
  results = $results
}
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'public-midl' }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
if ($mismatchCount -gt 0) {
  throw "$mismatchCount public MIDL target(s) need a reviewed TLB rebaseline. Report: $ReportPath"
}
Write-Host "Public MIDL verification passed. Report: $ReportPath"
