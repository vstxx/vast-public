param(
  [string] $Executable,
  [int] $TimeoutSeconds = 300,
  [switch] $KeepProfile,
  [switch] $SkipGoogleNavigation,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Executable) {
  $out = Join-Path (Get-VastChromiumSrc) (Get-VastChromiumOut)
  $vast = Join-Path $out 'Vast.exe'
  $Executable = if (Test-Path -LiteralPath $vast) { $vast } else { Join-Path $out 'chrome.exe' }
}
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Browser executable not found: $Executable" }

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$profile = Join-Path $tempRoot ("VastChromiumSmoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile | Out-Null
$process = $null
try {
  $arguments = @(
    "--user-data-dir=$profile",
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'data:text/html,<title>Vast%20Chromium%20Smoke</title><h1>Vast%20Chromium%20Smoke</h1>'
  )
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
  $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
  $forbiddenFlags = @(
    '--no-sandbox',
    '--disable-web-security',
    '--disable-site-isolation-trials',
    '--ignore-certificate-errors'
  )
  foreach ($flag in $forbiddenFlags) {
    if ($commandLine -match [regex]::Escape($flag)) { throw "Forbidden security flag detected: $flag" }
  }
  $portFile = Join-Path $profile 'DevToolsActivePort'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $portFile)) {
    if ($process.HasExited) { throw "Browser exited early with code $($process.ExitCode)." }
    Start-Sleep -Milliseconds 250
    $process.Refresh()
  }
  if (-not (Test-Path -LiteralPath $portFile)) { throw 'Timed out waiting for DevToolsActivePort.' }
  $port = [int](Get-Content -LiteralPath $portFile | Select-Object -First 1)
  $version = $null
  $devToolsDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $devToolsDeadline -and -not $version) {
    try {
      $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
    } catch {
      if ($process.HasExited) { throw "Browser exited early with code $($process.ExitCode)." }
      Start-Sleep -Milliseconds 250
      $process.Refresh()
    }
  }
  if (-not $version) { throw 'Timed out waiting for the DevTools HTTP endpoint.' }
  $smokePageObserved = $false
  $pageDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $pageDeadline -and -not $smokePageObserved) {
    $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
    $smokePageObserved = @($pages).title -contains 'Vast Chromium Smoke'
    if (-not $smokePageObserved) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $version.Browser -or -not $smokePageObserved) {
    throw 'The browser launched, but the smoke page was not observable through DevTools.'
  }
  if ($version.Browser -match 'Electron') { throw "Electron runtime detected: $($version.Browser)" }
  $newTabUri = "http://127.0.0.1:$port/json/new?" + [uri]::EscapeDataString('data:text/html,<title>Vast Second Tab</title>')
  Invoke-RestMethod -Method Put -Uri $newTabUri -TimeoutSec 5 | Out-Null
  $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
  if (@($pages | Where-Object { $_.type -eq 'page' }).Count -lt 2) {
    throw 'Chromium did not create a second normal tab through the DevTools endpoint.'
  }
  $googleObserved = $false
  if (-not $SkipGoogleNavigation) {
    $googleUri = "http://127.0.0.1:$port/json/new?" + [uri]::EscapeDataString('https://accounts.google.com/')
    Invoke-RestMethod -Method Put -Uri $googleUri -TimeoutSec 5 | Out-Null
    $googleDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $googleDeadline -and -not $googleObserved) {
      $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
      $googleObserved = $null -ne ($pages | Where-Object {
        $_.type -eq 'page' -and $_.url -match '^https://accounts\.google\.com/'
      } | Select-Object -First 1)
      if (-not $googleObserved) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $googleObserved) { throw 'accounts.google.com was not observable as a normal top-level tab.' }
  }
  if (-not $ReportPath) { $ReportPath = New-VastReportPath 'launch-smoke' }
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    executable = $Executable
    browser = $version.Browser
    devTools = $true
    multiTab = $true
    googleNavigationSkipped = [bool]$SkipGoogleNavigation
    googleTopLevel = $googleObserved
    securityBypassFlagsAbsent = $true
  }
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  Write-Host "PASS $($version.Browser); multi-tab=$true; googleTopLevel=$googleObserved; securityBypassFlags=$false; report=$ReportPath"
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(5000) | Out-Null
  }
  if (-not $KeepProfile) {
    $resolvedProfile = [System.IO.Path]::GetFullPath($profile)
    if (-not $resolvedProfile.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a profile outside the temp directory: $resolvedProfile"
    }
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
  }
}
