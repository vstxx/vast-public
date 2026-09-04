param(
  [string] $PackagePath,
  [string] $ExpectedVersion = '1.2.8.0',
  [ValidateRange(10, 120)]
  [int] $LaunchHealthSeconds = 15
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $env:CI -and $env:VAST_ALLOW_DESTRUCTIVE_STORE_E2E -ne 'YES') {
  throw 'Store install/upgrade E2E changes current-user package state. Run on an isolated CI user or set VAST_ALLOW_DESTRUCTIVE_STORE_E2E=YES.'
}
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Store install/upgrade E2E requires an elevated isolated Windows runner so its ephemeral package certificate can be trusted machine-wide and removed after the test.'
}
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $candidate = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'release\store') -Filter '*-Development.msix' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $candidate) { throw 'No development Store MSIX was found. Build one with npm run dist:store:dev or pass -PackagePath.' }
  $PackagePath = $candidate.FullName
}
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$packagesRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Packages'))
$preexistingPackageData = @(Get-ChildItem -LiteralPath $packagesRoot -Directory -Filter 'VastBrowser.Development_*' -ErrorAction SilentlyContinue)
if ($preexistingPackageData.Count -ne 0) {
  throw 'Store E2E requires an isolated user with no existing Vast development package data.'
}
$profileRoot = $null
$packageDataRoot = $null

$sdkBin = Get-ChildItem -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin') -Directory -ErrorAction Stop |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64' } |
  Where-Object { Test-Path -LiteralPath (Join-Path $_ 'MakeAppx.exe') } |
  Select-Object -First 1
if (-not $sdkBin) { throw 'Current x64 Windows SDK MakeAppx tool was not found.' }
$makeAppx = Join-Path $sdkBin 'MakeAppx.exe'
$signTool = Join-Path $sdkBin 'SignTool.exe'
if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) { throw 'Current x64 Windows SDK SignTool was not found.' }
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vast-store-upgrade-{0}" -f [Guid]::NewGuid().ToString('N'))
$unpackedRoot = Join-Path $testRoot 'unpacked'
$lowerPackage = Join-Path $testRoot 'Vast-Store-lower.msix'
$currentPackage = Join-Path $testRoot 'Vast-Store-current.msix'
$testCertificatePath = Join-Path $testRoot 'Vast-Store-E2E.cer'
$installed = $null
$testCertificateThumbprint = $null

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Get-PackagedVastProcesses([string] $InstallLocation) {
  @(Get-Process -Name Vast -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path.StartsWith($InstallLocation, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
}

function Start-PackagedVast([string] $PackageFamilyName, [string] $InstallLocation) {
  Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$PackageFamilyName!Vast" | Out-Null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $process = Get-PackagedVastProcesses $InstallLocation |
      Sort-Object StartTime |
      Select-Object -First 1
    if ($process) { return $process }
  }
  throw 'Packaged Vast did not launch through its registered AppUserModelId.'
}

function Get-VastApplicationErrors([datetime] $Since, [string] $InstallLocation) {
  $expectedExecutable = Join-Path $InstallLocation 'Vast.exe'
  @(Get-WinEvent -FilterHashtable @{
      LogName = 'Application'
      ProviderName = 'Application Error'
      Id = 1000
      StartTime = $Since
    } -ErrorAction SilentlyContinue | Where-Object {
      $_.Properties.Count -gt 10 -and
      [string]::Equals([string] $_.Properties[10].Value, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Assert-PackagedVastLaunchHealthy([string] $PackageFamilyName, [string] $InstallLocation) {
  $startedAt = (Get-Date).AddSeconds(-1)
  $process = Start-PackagedVast $PackageFamilyName $InstallLocation
  $deadline = (Get-Date).AddSeconds($LaunchHealthSeconds)
  $sawChildProcess = $false

  while ((Get-Date) -lt $deadline) {
    $liveProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (-not $liveProcess) {
      Start-Sleep -Milliseconds 750
      $errors = @(Get-VastApplicationErrors $startedAt $InstallLocation)
      $detail = if ($errors.Count) {
        $latest = $errors | Sort-Object TimeCreated -Descending | Select-Object -First 1
        " Application Error $($latest.Id), exception $($latest.Properties[6].Value), report $($latest.Properties[12].Value)."
      } else { '' }
      throw "Packaged Vast exited before the $LaunchHealthSeconds-second launch health window completed.$detail"
    }
    if ((Get-PackagedVastProcesses $InstallLocation).Count -ge 2) { $sawChildProcess = $true }
    Start-Sleep -Milliseconds 250
  }

  $errors = @(Get-VastApplicationErrors $startedAt $InstallLocation)
  Assert-True ($errors.Count -eq 0) 'packaged Vast produced an Application Error event during the launch health window'
  Assert-True $sawChildProcess 'packaged Vast did not create a renderer or utility child process during launch'
  return $process
}

function Stop-PackagedVast([string] $InstallLocation) {
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    $processes = @(Get-PackagedVastProcesses $InstallLocation)
    if ($processes.Count -eq 0) { return }
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 250
  }
  throw 'Packaged Vast processes did not exit before package servicing.'
}

function Wait-PackagedVastRemoval([string] $PackageName, [string] $InstallLocation, [string] $PackageDataRoot) {
  # Remove-AppxPackage returns before AppX servicing always releases and removes
  # the immutable install directory. Observe all owned state instead of racing
  # the servicing process or deleting WindowsApps content ourselves.
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    $registered = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
    $installExists = Test-Path -LiteralPath $InstallLocation
    $dataExists = Test-Path -LiteralPath $PackageDataRoot
    if (-not $registered -and -not $installExists -and -not $dataExists) { return }
    Start-Sleep -Milliseconds 250
  }
}

try {
  $existing = Get-AppxPackage -Name 'VastBrowser.Development' -ErrorAction SilentlyContinue
  if ($existing) { throw 'A VastBrowser.Development package is already installed for this user.' }

  New-Item -ItemType Directory -Path $unpackedRoot -Force | Out-Null
  Write-Host '[store-e2e] Unpacking the current development MSIX.'
  $unpackOutput = @(& $makeAppx unpack /p $resolvedPackage /d $unpackedRoot /o 2>&1)
  $unpackExitCode = $LASTEXITCODE
  if ($unpackExitCode -ne 0) {
    $unpackOutput | Out-Host
    throw 'Could not unpack the development MSIX.'
  }
  $manifestPath = Join-Path $unpackedRoot 'AppxManifest.xml'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw
  Assert-True ($manifest -match "Version=`"$([regex]::Escape($ExpectedVersion))`"") 'development MSIX has the expected current version'
  $testPublisher = 'CN=Vast Browser Development'
  $testManifest = $manifest
  Assert-True ($testManifest -match 'Publisher="CN=Vast Browser Development"') 'development manifest must use the isolated local-test publisher'
  Set-Content -LiteralPath $manifestPath -Value $testManifest -Encoding UTF8
  Write-Host '[store-e2e] Repacking the current test MSIX.'
  $packCurrentOutput = @(& $makeAppx pack /d $unpackedRoot /p $currentPackage /o /nc 2>&1)
  $packCurrentExitCode = $LASTEXITCODE
  if ($packCurrentExitCode -ne 0) {
    $packCurrentOutput | Out-Host
    throw 'Could not create the current test MSIX.'
  }
  $lowerManifest = $testManifest -replace "Version=`"$([regex]::Escape($ExpectedVersion))`"", 'Version="1.2.7.0"'
  Set-Content -LiteralPath $manifestPath -Value $lowerManifest -Encoding UTF8
  Write-Host '[store-e2e] Repacking the lower-version test MSIX.'
  $packOutput = @(& $makeAppx pack /d $unpackedRoot /p $lowerPackage /o /nc 2>&1)
  $packExitCode = $LASTEXITCODE
  if ($packExitCode -ne 0) {
    $packOutput | Out-Host
    throw 'Could not create the lower-version MSIX.'
  }
  Write-Host '[store-e2e] Creating an ephemeral current-user certificate for local package activation.'
  $testCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $testPublisher `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddDays(1) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
  $testCertificateThumbprint = $testCertificate.Thumbprint
  Export-Certificate -Cert $testCertificate -FilePath $testCertificatePath -Type CERT | Out-Null
  # Windows only honors packaged-classic-app activation for a test certificate
  # trusted by the local machine. Production MSIX files remain unsigned until
  # Partner Center applies the Microsoft Store signature.
  Import-Certificate -FilePath $testCertificatePath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  foreach ($package in @($lowerPackage, $currentPackage)) {
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $signOutput = @(& $signTool sign /debug /fd SHA256 /sha1 $testCertificateThumbprint /s My $package 2>&1)
      $signExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorPreference
    }
    if ($signExitCode -ne 0) {
      $signOutput | Out-Host
      throw "Could not sign temporary Store E2E package $package."
    }
  }
  Write-Host '[store-e2e] Signed local test MSIX fixtures created.'

  Write-Host '[store-e2e] Installing the lower-version locally signed test MSIX.'
  Add-AppxPackage -Path $lowerPackage
  $installed = Get-AppxPackage -Name 'VastBrowser.Development' -ErrorAction Stop
  Assert-True ($installed.Version.ToString() -eq '1.2.7.0') 'lower package must install first'
  $packageDataRoot = [System.IO.Path]::GetFullPath((Join-Path $packagesRoot $installed.PackageFamilyName))
  Assert-True ($packageDataRoot.StartsWith(($packagesRoot + [System.IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) 'package data root must remain inside the current user Packages directory'
  $profileRoot = [System.IO.Path]::GetFullPath((Join-Path $packageDataRoot 'LocalCache\Roaming\Vast'))
  Write-Host '[store-e2e] Launching the lower-version package.'
  $firstProcess = Assert-PackagedVastLaunchHealthy $installed.PackageFamilyName $installed.InstallLocation
  Stop-PackagedVast $installed.InstallLocation
  for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path -LiteralPath $profileRoot); $attempt += 1) { Start-Sleep -Milliseconds 250 }
  Assert-True (Test-Path -LiteralPath $profileRoot -PathType Container) 'packaged Vast must use the shared roaming Vast profile'

  $probeRoot = Join-Path $profileRoot 'StoreUpgradeEvidence'
  New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
  $probeFiles = [ordered]@{
    'settings-session.txt' = 'settings-session-preserved'
    'relay-identity.txt' = 'relay-identity-preserved'
    'password-vault.txt' = 'encrypted-vault-location-preserved'
    'extension-state.txt' = 'extension-state-preserved'
  }
  foreach ($entry in $probeFiles.GetEnumerator()) {
    Set-Content -LiteralPath (Join-Path $probeRoot $entry.Key) -Value $entry.Value -NoNewline -Encoding UTF8
  }
  $before = $probeFiles.GetEnumerator() | ForEach-Object {
    $relativePath = Join-Path 'StoreUpgradeEvidence' $_.Key
    [pscustomobject]@{ Path = $relativePath; Hash = (Get-FileHash -LiteralPath (Join-Path $profileRoot $relativePath) -Algorithm SHA256).Hash }
  }

  Write-Host '[store-e2e] Upgrading to the current locally signed test MSIX.'
  Add-AppxPackage -Path $currentPackage -ForceUpdateFromAnyVersion -ForceApplicationShutdown
  $installed = Get-AppxPackage -Name 'VastBrowser.Development' -ErrorAction Stop
  Assert-True ($installed.Version.ToString() -eq $ExpectedVersion) 'current package must replace the lower package'
  Write-Host '[store-e2e] Launching the upgraded package.'
  $secondProcess = Assert-PackagedVastLaunchHealthy $installed.PackageFamilyName $installed.InstallLocation
  Stop-PackagedVast $installed.InstallLocation
  foreach ($entry in $before) {
    Assert-True (Test-Path -LiteralPath (Join-Path $profileRoot $entry.Path) -PathType Leaf) "upgrade removed profile file $($entry.Path)"
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $profileRoot $entry.Path) -Algorithm SHA256).Hash -eq $entry.Hash) "upgrade changed preserved profile file $($entry.Path)"
  }

  $packageFamilyName = $installed.PackageFamilyName
  $installLocation = $installed.InstallLocation
  Write-Host '[store-e2e] Removing the upgraded package.'
  Remove-AppxPackage -Package $installed.PackageFullName
  $installed = $null
  Wait-PackagedVastRemoval 'VastBrowser.Development' $installLocation $packageDataRoot
  Assert-True (-not (Get-AppxPackage -Name 'VastBrowser.Development' -ErrorAction SilentlyContinue)) 'MSIX uninstall must remove the registered Vast development package'
  Assert-True (-not (Test-Path -LiteralPath $installLocation)) 'MSIX uninstall must remove the immutable package installation directory'
  Assert-True (-not (Test-Path -LiteralPath $packageDataRoot)) 'MSIX uninstall must remove the Vast-owned per-user package data container'
  $orphanedPackageData = @(Get-ChildItem -LiteralPath $packagesRoot -Directory -Filter 'VastBrowser.Development_*' -ErrorAction SilentlyContinue)
  Assert-True ($orphanedPackageData.Count -eq 0) 'MSIX uninstall must leave no Vast development package data directory'
  Write-Host '[store-e2e] Install, launch, upgrade and uninstall checks passed.'
  [ordered]@{
    ok = $true
    lowerVersion = '1.2.7.0'
    currentVersion = $ExpectedVersion
    packageFamilyName = $packageFamilyName
    profilePath = $profileRoot
    launchHealthSeconds = $LaunchHealthSeconds
    preservedFileCount = $before.Count
    packageDataRemovedOnUninstall = $true
  } | ConvertTo-Json
} finally {
  if ($installed) {
    try { Stop-PackagedVast $installed.InstallLocation } catch { Write-Warning 'Could not stop packaged Vast during final cleanup.' }
    Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction SilentlyContinue
  }
  if ($packageDataRoot -and (Test-Path -LiteralPath $packageDataRoot)) {
    $resolvedPackageData = [System.IO.Path]::GetFullPath($packageDataRoot)
    if ($resolvedPackageData.StartsWith(($packagesRoot + [System.IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedPackageData -Recurse -Force
    }
  }
  if ($testCertificateThumbprint) {
    foreach ($storePath in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople')) {
      $certificatePath = Join-Path $storePath $testCertificateThumbprint
      if (Test-Path -LiteralPath $certificatePath) {
        Remove-Item -LiteralPath $certificatePath -Force
      }
    }
  }
  if (Test-Path -LiteralPath $testRoot) {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
  }
}
