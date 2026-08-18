param(
  [string]$ExePath = (Join-Path $PSScriptRoot '..\.vast-test-artifacts\final-polish-test-final-native\win-unpacked\Vast.exe'),
  [ValidateSet('chromium-runtime', 'native-electron')]
  [string]$IdentityProfile = 'native-electron'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:VAST_GOOGLE_AUTH_TEST_EMAIL) -or $env:VAST_GOOGLE_AUTH_TEST_EMAIL -notmatch '^\S+@\S+\.\S+$') {
  throw 'Set VAST_GOOGLE_AUTH_TEST_EMAIL to the account address used for this email-only check.'
}

$resolvedExe = [IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $resolvedExe -PathType Leaf)) {
  throw "Packaged Vast executable not found: $resolvedExe"
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runId = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$artifactsDir = Join-Path $root ".vast-test-artifacts\google-auth-live-ui-check\$runId"
$profile = Join-Path $env:TEMP "vast-google-auth-ui-$([guid]::NewGuid().ToString('N'))"
$resolvedProfile = [IO.Path]::GetFullPath($profile)
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
$productionProfile = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Vast'))

if (-not $resolvedProfile.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing test profile outside the temporary directory: $resolvedProfile"
}
if ($resolvedProfile.StartsWith($productionProfile, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing production Vast profile: $resolvedProfile"
}

New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedProfile -Force | Out-Null

$authLog = Join-Path $resolvedProfile 'Logs\google-auth.log'
$authLogCopy = Join-Path $artifactsDir 'google-auth.redacted.log'
$summaryPath = Join-Path $artifactsDir 'summary.json'
$process = $null
$result = 'INCONCLUSIVE'
$passed = $false
$finalUrlShape = 'unavailable'
$previousUserData = $env:VAST_TEST_USER_DATA_DIR
$previousUpdateEnabled = $env:VAST_UPDATE_ENABLED
$previousInternalCheck = $env:VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK
$previousIdentityProfile = $env:VAST_INTERNAL_GOOGLE_AUTH_IDENTITY

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Label) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Label."
}

function Read-AuthLog {
  if (-not (Test-Path -LiteralPath $authLog -PathType Leaf)) { return '' }
  return [IO.File]::ReadAllText($authLog)
}

try {
  $env:VAST_TEST_USER_DATA_DIR = $resolvedProfile
  $env:VAST_UPDATE_ENABLED = '0'
  $env:VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK = '1'
  $env:VAST_INTERNAL_GOOGLE_AUTH_IDENTITY = $IdentityProfile
  $process = Start-Process -FilePath $resolvedExe -PassThru

  Wait-Until {
    $process.Refresh()
    if ($process.HasExited) { throw "Packaged Vast exited early with code $($process.ExitCode)." }
    return $process.MainWindowHandle -ne 0
  } 20 'the packaged Vast main window'

  Wait-Until {
    $log = Read-AuthLog
    return $log -match 'popup loaded .*accounts\.google\.com/v3/signin/identifier'
  } 45 'the Google identifier page in the sterile auth window'

  Wait-Until {
    $log = Read-AuthLog
    return $log -match 'accounts\.google\.com/v3/signin/(?:challenge/pwd|rejected)'
  } 45 'a Google password challenge or explicit provider rejection'

  $finalLog = Read-AuthLog
  if ($finalLog -match 'accounts\.google\.com/v3/signin/challenge/pwd') {
    $result = 'EMAIL_ACCEPTED_AUTH_CONTINUES'
    $passed = $true
    $finalUrlShape = 'https://accounts.google.com/v3/signin/challenge/pwd'
  } elseif ($finalLog -match 'accounts\.google\.com/v3/signin/rejected') {
    $result = 'PROVIDER_BLOCK_AFTER_EMAIL'
    $finalUrlShape = 'https://accounts.google.com/v3/signin/rejected'
  }
} catch {
  $result = $_.Exception.Message
} finally {
  if (Test-Path -LiteralPath $authLog -PathType Leaf) {
    Copy-Item -LiteralPath $authLog -Destination $authLogCopy -Force
  }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
  }
  $env:VAST_TEST_USER_DATA_DIR = $previousUserData
  $env:VAST_UPDATE_ENABLED = $previousUpdateEnabled
  $env:VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK = $previousInternalCheck
  $env:VAST_INTERNAL_GOOGLE_AUTH_IDENTITY = $previousIdentityProfile

  $summary = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    result = $result
    passed = $passed
    runtime = 'packaged-test-build'
    identityProfile = $IdentityProfile
    input = 'electron-input-events-no-dom-or-debugger'
    debuggerAttachedByTest = $false
    identityInput = 'email-only-not-persisted'
    finalUrlShape = $finalUrlShape
    passwordEntered = $false
    cookiesImported = $false
    productionProfileUsed = $false
    authLogCaptured = (Test-Path -LiteralPath $authLogCopy -PathType Leaf)
  }
  $summary | ConvertTo-Json | Set-Content -LiteralPath $summaryPath -Encoding UTF8

  # Remove the temporary browser profile because it may contain provider state.
  if ($resolvedProfile.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Get-Content -LiteralPath $summaryPath
Write-Host "Artifacts: $artifactsDir"
if (-not $passed) { exit 1 }
