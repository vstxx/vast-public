[CmdletBinding()]
param(
  [string] $InstallPath = '',
  [string] $PayloadPath = '',
  [string] $UserDataRoot = '',
  [string] $BackupRoot = '',
  [string] $ConfigPath = '',
  [string] $LogPath = '',
  [string] $TargetVersion = '1.0.8',
  [string] $TargetEdition = '',
  [switch] $ForceClose,
  [switch] $NonInteractive,
  [switch] $DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:VastLogPath = $null
$script:VastDefaultCriticalItems = @(
  'vast-data.json',
  'password-vault.json',
  'vast-network-devices.json',
  'Local State',
  'Preferences',
  'Network',
  'Cookies',
  'Cookies-journal',
  'Partitions',
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'Service Worker',
  'WebStorage',
  'SharedStorage',
  'Shared Dictionary',
  'DIPS',
  'Trust Tokens',
  'QuotaManager',
  'File System',
  'databases',
  'Platform Notifications',
  'profiles',
  'Profiles',
  'settings',
  'settings.json',
  'bookmarks',
  'Bookmarks',
  'sessions',
  'Sessions',
  'notes',
  'Notes',
  'passwords',
  'Passwords',
  'Local Vault',
  'vault',
  'Vault',
  'workspaces',
  'Workspaces',
  'workspace',
  'Workspace'
)
$script:VastDefaultOptionalItems = @(
  'Cache',
  'cache',
  'Code Cache',
  'GPUCache',
  'Service Worker'
)
$script:VastBackupVolatileDirectoryNames = @(
  'Cache',
  'cache',
  'CacheStorage',
  'Code Cache',
  'DawnCache',
  'GPUCache',
  'GrShaderCache',
  'Media Cache',
  'ScriptCache',
  'ShaderCache',
  'blob_storage',
  'Crashpad',
  'Logs',
  'logs'
)
$script:VastRuntimeExcludeSegments = @(
  '.vast-update',
  'Backups',
  'Cache',
  'cache',
  'Code Cache',
  'GPUCache',
  'Local Vault',
  'Notes',
  'notes',
  'Passwords',
  'passwords',
  'Profiles',
  'profiles',
  'Sessions',
  'sessions',
  'User Data',
  'Vault',
  'vault',
  'Workspaces',
  'workspaces'
)

function Initialize-VastLogging {
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $base = $env:TEMP
    if ([string]::IsNullOrWhiteSpace($base)) {
      $base = [System.IO.Path]::GetTempPath()
    }
    $Path = Join-Path $base 'VastUpdater-1.0.8.log'
  }

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  $script:VastLogPath = $Path
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType File -Path $Path -Force | Out-Null
  }
}

function Write-VastLog {
  param(
    [string] $Message,
    [string] $Level = 'INFO'
  )

  $line = '[{0}] [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Level.ToUpperInvariant(), $Message
  if ($script:VastLogPath) {
    try {
      Add-Content -LiteralPath $script:VastLogPath -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
      Write-Warning "Could not write Vast updater log '$script:VastLogPath': $($_.Exception.Message)"
    }
  }
}

function Expand-VastPath {
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ''
  }

  return [Environment]::ExpandEnvironmentVariables($Path)
}

function Read-VastJsonFile {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    Write-VastLog "Could not parse JSON file '$Path': $($_.Exception.Message)" 'WARN'
    return $null
  }
}

function Read-VastUpdaterConfig {
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Join-Path $PSScriptRoot 'updater.config.json'
  }

  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{}
  }

  $config = Read-VastJsonFile -Path $Path
  if ($null -eq $config) {
    throw "Updater configuration is unreadable: $Path"
  }

  return $config
}

function ConvertTo-VastSemVer {
  param([string] $Version)

  if ([string]::IsNullOrWhiteSpace($Version) -or $Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw "Invalid Vast semantic version '$Version'."
  }

  $preRelease = @()
  if (-not [string]::IsNullOrWhiteSpace($Matches[4])) {
    $preRelease = @($Matches[4].Split('.'))
  }
  return [pscustomobject]@{
    Major = [int64] $Matches[1]
    Minor = [int64] $Matches[2]
    Patch = [int64] $Matches[3]
    PreRelease = $preRelease
    Normalized = $Version
  }
}

function Compare-VastSemVer {
  param(
    [string] $Left,
    [string] $Right
  )

  $leftVersion = ConvertTo-VastSemVer -Version $Left
  $rightVersion = ConvertTo-VastSemVer -Version $Right

  foreach ($field in @('Major', 'Minor', 'Patch')) {
    if ($leftVersion.$field -lt $rightVersion.$field) {
      return -1
    }
    if ($leftVersion.$field -gt $rightVersion.$field) {
      return 1
    }
  }

  $leftPre = @($leftVersion.PreRelease)
  $rightPre = @($rightVersion.PreRelease)
  if ($leftPre.Count -eq 0 -and $rightPre.Count -eq 0) { return 0 }
  if ($leftPre.Count -eq 0) { return 1 }
  if ($rightPre.Count -eq 0) { return -1 }

  $count = [Math]::Max($leftPre.Count, $rightPre.Count)
  for ($i = 0; $i -lt $count; $i++) {
    if ($i -ge $leftPre.Count) { return -1 }
    if ($i -ge $rightPre.Count) { return 1 }
    $leftIdentifier = [string] $leftPre[$i]
    $rightIdentifier = [string] $rightPre[$i]
    [int64] $leftNumber = 0
    [int64] $rightNumber = 0
    $leftNumeric = [int64]::TryParse($leftIdentifier, [ref] $leftNumber)
    $rightNumeric = [int64]::TryParse($rightIdentifier, [ref] $rightNumber)
    if ($leftNumeric -and $rightNumeric) {
      if ($leftNumber -lt $rightNumber) { return -1 }
      if ($leftNumber -gt $rightNumber) { return 1 }
      continue
    }
    if ($leftNumeric -and -not $rightNumeric) { return -1 }
    if (-not $leftNumeric -and $rightNumeric) { return 1 }
    $comparison = [string]::CompareOrdinal($leftIdentifier, $rightIdentifier)
    if ($comparison -lt 0) { return -1 }
    if ($comparison -gt 0) { return 1 }
  }

  return 0
}

function Select-VastApplicationVersion {
  param([string[]] $CandidateVersions)

  foreach ($candidate in $CandidateVersions) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }

    if ($candidate -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
      continue
    }

    [int] $major = [int] $Matches[1]
    $version = $candidate

    if ($major -ge 20) {
      Write-VastLog "Ignoring runtime version '$version' while detecting Vast app version." 'WARN'
      continue
    }

    return $version
  }

  return ''
}

function Test-VastRelativePathIsUserData {
  param([string] $RelativePath)

  $segments = ($RelativePath -replace '/', '\').Split('\')
  foreach ($segment in $segments) {
    if ($script:VastRuntimeExcludeSegments -contains $segment) {
      return $true
    }
  }

  return $false
}

function Test-VastInstallPath {
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }

  $expanded = Expand-VastPath -Path $Path
  $exe = Join-Path $expanded 'Vast.exe'
  $resources = Join-Path $expanded 'resources'
  return ((Test-Path -LiteralPath $exe -PathType Leaf) -and (Test-Path -LiteralPath $resources -PathType Container))
}

function Get-VastPropertyString {
  param(
    [object] $InputObject,
    [string] $Name
  )

  if ($null -eq $InputObject -or -not ($InputObject.PSObject.Properties.Name -contains $Name)) {
    return ''
  }

  return [string] $InputObject.$Name
}

function Get-VastRegistryInstallPaths {
  $paths = New-Object System.Collections.Generic.List[string]
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  foreach ($root in $registryRoots) {
    try {
      $items = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
        Where-Object {
          $displayName = Get-VastPropertyString -InputObject $_ -Name 'DisplayName'
          $publisher = Get-VastPropertyString -InputObject $_ -Name 'Publisher'
          $displayIcon = Get-VastPropertyString -InputObject $_ -Name 'DisplayIcon'
          $uninstallString = Get-VastPropertyString -InputObject $_ -Name 'UninstallString'
          ($displayName -match '^Vast(\sBrowser)?(\s+\d+\.\d+\.\d+)?$') -or
          ($publisher -match '^Vast$') -or
          ($_.PSChildName -match 'vast') -or
          ($displayIcon -match 'vast-browser|Vast\.exe') -or
          ($uninstallString -match 'vast-browser|Vast')
        }

      foreach ($item in $items) {
        $installLocation = Get-VastPropertyString -InputObject $item -Name 'InstallLocation'
        $displayIcon = Get-VastPropertyString -InputObject $item -Name 'DisplayIcon'
        $uninstallString = Get-VastPropertyString -InputObject $item -Name 'UninstallString'

        if ($installLocation) {
          $paths.Add($installLocation)
        } elseif ($displayIcon) {
          $iconPath = $displayIcon.Trim('"')
          if ($iconPath -match '\.exe') {
            $paths.Add((Split-Path -Parent $iconPath))
          }
        } elseif ($uninstallString) {
          $uninstall = $uninstallString.Trim('"')
          if ($uninstall -match '\.exe') {
            $paths.Add((Split-Path -Parent $uninstall))
          }
        }
      }
    } catch {
      Write-VastLog "Registry install detection failed for '$root': $($_.Exception.Message)" 'WARN'
    }
  }

  return $paths.ToArray()
}

function Get-VastRegistryInstallVersion {
  param([string] $InstallPath)

  if ([string]::IsNullOrWhiteSpace($InstallPath) -or -not (Test-Path -LiteralPath $InstallPath -PathType Container)) {
    return ''
  }

  $resolvedInstall = (Resolve-Path -LiteralPath $InstallPath).Path.TrimEnd('\').ToLowerInvariant()
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  foreach ($root in $registryRoots) {
    try {
      $items = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
        Where-Object {
          $displayName = Get-VastPropertyString -InputObject $_ -Name 'DisplayName'
          $publisher = Get-VastPropertyString -InputObject $_ -Name 'Publisher'
          $displayIcon = Get-VastPropertyString -InputObject $_ -Name 'DisplayIcon'
          $uninstallString = Get-VastPropertyString -InputObject $_ -Name 'UninstallString'
          ($displayName -match '^Vast(\sBrowser)?(\s+\d+\.\d+\.\d+)?$') -or
          ($publisher -match '^Vast$') -or
          ($_.PSChildName -match 'vast') -or
          ($displayIcon -match 'vast-browser|Vast\.exe') -or
          ($uninstallString -match 'vast-browser|Vast')
        }

      foreach ($item in $items) {
        $installMatches = $false
        foreach ($pathValue in @(
          (Get-VastPropertyString -InputObject $item -Name 'InstallLocation'),
          (Get-VastPropertyString -InputObject $item -Name 'DisplayIcon'),
          (Get-VastPropertyString -InputObject $item -Name 'UninstallString')
        )) {
          if ([string]::IsNullOrWhiteSpace([string] $pathValue)) {
            continue
          }

          $pathText = ([string] $pathValue).Trim('"')
          if ($pathText -match '\.exe') {
            $pathText = Split-Path -Parent $pathText
          }

          if (-not [string]::IsNullOrWhiteSpace($pathText) -and (Test-Path -LiteralPath $pathText -PathType Container)) {
            $resolvedPath = (Resolve-Path -LiteralPath $pathText).Path.TrimEnd('\').ToLowerInvariant()
            if ($resolvedPath -eq $resolvedInstall) {
              $installMatches = $true
              break
            }
          }
        }

        if ($installMatches) {
          $version = Select-VastApplicationVersion @((Get-VastPropertyString -InputObject $item -Name 'DisplayVersion'))
          if (-not [string]::IsNullOrWhiteSpace($version)) {
            return $version
          }
        }
      }
    } catch {
      Write-VastLog "Registry version detection failed for '$root': $($_.Exception.Message)" 'WARN'
    }
  }

  return ''
}

function ConvertTo-VastRegistryInstallRoot {
  param([string] $PathValue)

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ''
  }

  $pathText = [Environment]::ExpandEnvironmentVariables(([string] $PathValue).Trim())
  $exeMatch = [regex]::Match($pathText, '"?([^"]+?\.exe)"?(?:,.*|\s+.*)?$')
  if ($exeMatch.Success) {
    return Split-Path -Parent $exeMatch.Groups[1].Value
  }

  return $pathText.Trim('"')
}

function Update-VastRegistryMetadata {
  param(
    [string] $InstallPath,
    [string] $TargetVersion,
    [string[]] $RegistryRoots = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
  )

  if ([string]::IsNullOrWhiteSpace($InstallPath) -or -not (Test-Path -LiteralPath $InstallPath -PathType Container)) {
    return 0
  }

  $resolvedInstall = (Resolve-Path -LiteralPath $InstallPath).Path.TrimEnd('\').ToLowerInvariant()
  $updated = 0

  foreach ($root in $RegistryRoots) {
    try {
      $items = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
      foreach ($item in $items) {
        $installMatches = $false
        foreach ($pathValue in @(
          (Get-VastPropertyString -InputObject $item -Name 'InstallLocation'),
          (Get-VastPropertyString -InputObject $item -Name 'DisplayIcon'),
          (Get-VastPropertyString -InputObject $item -Name 'UninstallString')
        )) {
          $pathText = ConvertTo-VastRegistryInstallRoot -PathValue ([string] $pathValue)
          if ([string]::IsNullOrWhiteSpace($pathText) -or -not (Test-Path -LiteralPath $pathText -PathType Container)) {
            continue
          }

          $resolvedPath = (Resolve-Path -LiteralPath $pathText).Path.TrimEnd('\').ToLowerInvariant()
          if ($resolvedPath -eq $resolvedInstall) {
            $installMatches = $true
            break
          }
        }

        if (-not $installMatches) {
          continue
        }

        $keyPath = $item.PSPath
        Set-ItemProperty -LiteralPath $keyPath -Name 'DisplayName' -Value "Vast $TargetVersion" -ErrorAction Stop
        Set-ItemProperty -LiteralPath $keyPath -Name 'DisplayVersion' -Value $TargetVersion -ErrorAction Stop
        Set-ItemProperty -LiteralPath $keyPath -Name 'InstallLocation' -Value $InstallPath -ErrorAction Stop
        Set-ItemProperty -LiteralPath $keyPath -Name 'Publisher' -Value 'Vast' -ErrorAction Stop
        $updated++
      }
    } catch {
      Write-VastLog "Registry metadata update failed for '$root': $($_.Exception.Message)" 'WARN'
    }
  }

  if ($updated -gt 0) {
    Write-VastLog "Updated $updated registry uninstall entr$(if ($updated -eq 1) { 'y' } else { 'ies' }) to Vast $TargetVersion."
  } else {
    Write-VastLog "No matching registry uninstall entry found for '$InstallPath'." 'WARN'
  }

  return $updated
}

function Get-VastInstallCandidates {
  param([object] $Config)

  $candidates = New-Object System.Collections.Generic.List[string]

  if ($env:VAST_INSTALL_DIR) {
    $candidates.Add($env:VAST_INSTALL_DIR)
  }

  if ($Config -and ($Config.PSObject.Properties.Name -contains 'installPaths')) {
    foreach ($path in $Config.installPaths) {
      $candidates.Add([string] $path)
    }
  }

  foreach ($registryPath in (Get-VastRegistryInstallPaths)) {
    $candidates.Add($registryPath)
  }

  $commonPaths = @(
    '%LOCALAPPDATA%\Programs\Vast',
    '%LOCALAPPDATA%\Programs\Vast Browser',
    '%LOCALAPPDATA%\Programs\vast-browser',
    '%ProgramFiles%\Vast',
    '%ProgramFiles%\Vast Browser',
    '%ProgramFiles(x86)%\Vast',
    '%ProgramFiles(x86)%\Vast Browser'
  )

  foreach ($path in $commonPaths) {
    $candidates.Add($path)
  }

  $seen = @{}
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in $candidates) {
    $expanded = Expand-VastPath -Path $candidate
    if ([string]::IsNullOrWhiteSpace($expanded)) {
      continue
    }
    $key = $expanded.TrimEnd('\').ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $result.Add($expanded)
    }
  }

  return $result.ToArray()
}

function Resolve-VastInstallPath {
  param(
    [string] $RequestedPath,
    [object] $Config
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    $expanded = Expand-VastPath -Path $RequestedPath
    if (-not (Test-VastInstallPath -Path $expanded)) {
      throw "The supplied install path is not a valid Vast installation: $expanded"
    }
    return (Resolve-Path -LiteralPath $expanded).Path
  }

  foreach ($candidate in (Get-VastInstallCandidates -Config $Config)) {
    if (Test-VastInstallPath -Path $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Could not detect an existing Vast installation. Re-run with -InstallPath `"C:\Path\To\Vast`"."
}

function Resolve-VastPayloadPath {
  param(
    [string] $RequestedPath,
    [object] $Config,
    [string] $ConfigPath
  )

  $path = $RequestedPath
  if ([string]::IsNullOrWhiteSpace($path) -and $Config -and ($Config.PSObject.Properties.Name -contains 'payloadPath')) {
    $path = [string] $Config.payloadPath
  }

  if ([string]::IsNullOrWhiteSpace($path)) {
    $path = Join-Path (Split-Path -Parent $PSScriptRoot) 'Vast-1.0.8\win-unpacked'
  }

  $path = Expand-VastPath -Path $path
  if (-not [System.IO.Path]::IsPathRooted($path)) {
    $base = $PSScriptRoot
    if (-not [string]::IsNullOrWhiteSpace($ConfigPath) -and (Test-Path -LiteralPath $ConfigPath)) {
      $base = Split-Path -Parent (Resolve-Path -LiteralPath $ConfigPath).Path
    }
    $path = Join-Path $base $path
  }

  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw "Updater payload is missing: $path"
  }

  return (Resolve-Path -LiteralPath $path).Path
}

function Get-VastVersionFromJson {
  param([string] $Path)

  $json = Read-VastJsonFile -Path $Path
  if ($json -and ($json.PSObject.Properties.Name -contains 'version')) {
    return [string] $json.version
  }

  return ''
}

function Get-VastInstalledVersion {
  param([string] $InstallPath)

  $versionFiles = @(
    (Join-Path $InstallPath 'version.json'),
    (Join-Path $InstallPath 'resources\version.json'),
    (Join-Path $InstallPath 'resources\app\package.json'),
    (Join-Path $InstallPath 'package.json')
  )

  foreach ($file in $versionFiles) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $version = Get-VastVersionFromJson -Path $file
      if (-not [string]::IsNullOrWhiteSpace($version)) {
        return $version
      }
    }
  }

  $registryVersion = Get-VastRegistryInstallVersion -InstallPath $InstallPath
  if (-not [string]::IsNullOrWhiteSpace($registryVersion)) {
    return $registryVersion
  }

  $exe = Join-Path $InstallPath 'Vast.exe'
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    try {
      $versionInfo = (Get-Item -LiteralPath $exe).VersionInfo
      $exeVersion = Select-VastApplicationVersion @($versionInfo.ProductVersion, $versionInfo.FileVersion)
      if (-not [string]::IsNullOrWhiteSpace($exeVersion)) {
        return $exeVersion
      }
    } catch {
      Write-VastLog "Could not read Vast.exe version info: $($_.Exception.Message)" 'WARN'
    }
  }

  return '0.0.0'
}

function Test-VastPayload {
  param(
    [string] $PayloadPath,
    [string] $ExpectedVersion
  )

  $requiredFiles = @(
    'Vast.exe',
    'resources\app.asar'
  )

  foreach ($relative in $requiredFiles) {
    $path = Join-Path $PayloadPath $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Updater payload is incomplete. Missing required file: $relative"
    }
  }

  $payloadVersion = Get-VastInstalledVersion -InstallPath $PayloadPath
  if ($payloadVersion -ne '0.0.0' -and (Compare-VastSemVer $payloadVersion $ExpectedVersion) -ne 0) {
    throw "Updater payload version '$payloadVersion' does not match target version '$ExpectedVersion'."
  }
}

function Get-VastRuntimeRelativeFiles {
  param([string] $PayloadPath)

  $root = (Resolve-Path -LiteralPath $PayloadPath).Path.TrimEnd('\')
  $files = Get-ChildItem -LiteralPath $root -File -Recurse
  $result = New-Object System.Collections.Generic.List[string]

  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length).TrimStart('\')
    if (-not (Test-VastRelativePathIsUserData -RelativePath $relative)) {
      $result.Add($relative)
    }
  }

  return $result.ToArray()
}

function Get-VastFileHashString {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return ''
  }

  $stream = $null
  $sha256 = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha256.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '')
  } finally {
    if ($sha256) { $sha256.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Test-VastWritePermission {
  param([string] $InstallPath)

  $probe = Join-Path $InstallPath '.vast-write-test'
  try {
    Set-Content -LiteralPath $probe -Value 'write-test' -Encoding ASCII -Force
    Remove-Item -LiteralPath $probe -Force
  } catch {
    throw "Updater does not have permission to modify '$InstallPath'. Start it as an administrator or choose a writable install path. $($_.Exception.Message)"
  }
}

function Get-VastRunningProcesses {
  param(
    [string] $InstallPath,
    [object] $Config
  )

  $names = @('Vast')
  if ($Config -and ($Config.PSObject.Properties.Name -contains 'processNames')) {
    $names = @($Config.processNames)
  }

  $installRoot = (Resolve-Path -LiteralPath $InstallPath).Path.TrimEnd('\').ToLowerInvariant()
  $matches = New-Object System.Collections.Generic.List[object]

  foreach ($name in $names) {
    $processes = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($process in $processes) {
      $include = $true
      try {
        if ($process.Path) {
          $include = $process.Path.ToLowerInvariant().StartsWith($installRoot)
        }
      } catch {
        $include = $true
      }

      if ($include) {
        $matches.Add($process)
      }
    }
  }

  return $matches.ToArray()
}

function Stop-VastIfRequested {
  param(
    [string] $InstallPath,
    [object] $Config,
    [bool] $Force
  )

  $processes = @(Get-VastRunningProcesses -InstallPath $InstallPath -Config $Config)
  if ($processes.Count -eq 0) {
    return
  }

  $ids = ($processes | ForEach-Object { $_.Id }) -join ', '
  if (-not $Force) {
    throw "Vast is currently running (process id(s): $ids). Close Vast and run the updater again, or pass -ForceClose."
  }

  Write-VastLog "Closing running Vast process id(s): $ids" 'WARN'
  foreach ($process in $processes) {
    try {
      if (-not $process.CloseMainWindow()) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
      } else {
        $process.WaitForExit(10000) | Out-Null
        if (-not $process.HasExited) {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
      }
    } catch {
      if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        Write-VastLog "Vast process $($process.Id) exited while the updater was closing it."
        continue
      }
      throw "Could not close Vast process $($process.Id): $($_.Exception.Message)"
    }
  }
}

function Test-VastLockedTargets {
  param(
    [string] $InstallPath,
    [string] $PayloadPath
  )

  foreach ($relative in (Get-VastRuntimeRelativeFiles -PayloadPath $PayloadPath)) {
    $target = Join-Path $InstallPath $relative
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
      continue
    }

    try {
      $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $stream.Dispose()
    } catch {
      throw "Cannot update locked or protected file '$target'. Close Vast and any scanners using the file, then retry. $($_.Exception.Message)"
    }
  }
}

function Test-VastRuntimeMatchesPayload {
  param(
    [string] $InstallPath,
    [string] $PayloadPath
  )

  foreach ($relative in (Get-VastRuntimeRelativeFiles -PayloadPath $PayloadPath)) {
    $source = Join-Path $PayloadPath $relative
    $target = Join-Path $InstallPath $relative
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
      return $false
    }

    if ((Get-VastFileHashString -Path $source) -ne (Get-VastFileHashString -Path $target)) {
      return $false
    }
  }

  return $true
}

function Get-VastConfiguredDataRoot {
  $configPath = Expand-VastPath -Path '%APPDATA%\Vast\data-root.json'
  if ([string]::IsNullOrWhiteSpace($configPath) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    return ''
  }

  $config = Read-VastJsonFile -Path $configPath
  if ($null -eq $config -or -not ($config.PSObject.Properties.Name -contains 'customDataRoot')) {
    return ''
  }

  $customRoot = Expand-VastPath -Path ([string] $config.customDataRoot)
  if ([string]::IsNullOrWhiteSpace($customRoot)) {
    return ''
  }

  return $customRoot
}

function Get-VastUserDataRoots {
  param(
    [string] $RequestedUserDataRoot,
    [object] $Config
  )

  $roots = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($RequestedUserDataRoot)) {
    $roots.Add($RequestedUserDataRoot)
  } else {
    $configuredDataRoot = Get-VastConfiguredDataRoot
    if (-not [string]::IsNullOrWhiteSpace($configuredDataRoot)) {
      $roots.Add($configuredDataRoot)
    }
  }

  if ([string]::IsNullOrWhiteSpace($RequestedUserDataRoot) -and $Config -and ($Config.PSObject.Properties.Name -contains 'userDataPaths')) {
    foreach ($path in $Config.userDataPaths) {
      $roots.Add([string] $path)
    }
  } elseif ([string]::IsNullOrWhiteSpace($RequestedUserDataRoot)) {
    $roots.Add('%APPDATA%\Vast')
    $roots.Add('%APPDATA%\vast-browser')
    $roots.Add('%LOCALAPPDATA%\Vast')
    $roots.Add('%LOCALAPPDATA%\vast-browser')
  }

  $seen = @{}
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($root in $roots) {
    $expanded = Expand-VastPath -Path $root
    if ([string]::IsNullOrWhiteSpace($expanded)) {
      continue
    }
    $key = $expanded.TrimEnd('\').ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $result.Add($expanded)
    }
  }

  return $result.ToArray()
}

function Test-VastBackupVolatileDirectory {
  param([string] $Name)

  return ($script:VastBackupVolatileDirectoryNames -contains $Name)
}

function Copy-VastBackupDirectory {
  param(
    [string] $Source,
    [string] $Destination,
    [bool] $IsRoot = $false
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    if ($IsRoot) {
      throw "Critical backup directory disappeared before it could be copied: $Source"
    }
    Write-VastLog "Backup directory disappeared during copy, skipping: $Source" 'WARN'
    return
  }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  try {
    $children = @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop)
  } catch {
    if (-not (Test-Path -LiteralPath $Source)) {
      if ($IsRoot) {
        throw "Critical backup directory disappeared while it was being enumerated: $Source"
      }
      Write-VastLog "Backup directory disappeared during enumeration, skipping: $Source" 'WARN'
      return
    }
    throw
  }

  foreach ($child in $children) {
    $target = Join-Path $Destination $child.Name
    if ($child.PSIsContainer) {
      if (Test-VastBackupVolatileDirectory -Name $child.Name) {
        Write-VastLog "Skipping recoverable Chromium cache during user data backup: $($child.FullName)"
        continue
      }
      if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Write-VastLog "Skipping reparse point during user data backup: $($child.FullName)" 'WARN'
        continue
      }
      Copy-VastBackupDirectory -Source $child.FullName -Destination $target
      continue
    }

    try {
      Copy-Item -LiteralPath $child.FullName -Destination $target -Force -ErrorAction Stop
    } catch {
      if (-not (Test-Path -LiteralPath $child.FullName)) {
        Write-VastLog "Recoverable file disappeared during user data backup, skipping: $($child.FullName)" 'WARN'
        continue
      }
      throw
    }
  }
}

function Copy-VastBackupItem {
  param(
    [string] $Source,
    [string] $Destination
  )

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (Test-Path -LiteralPath $Source -PathType Container) {
    Copy-VastBackupDirectory -Source $Source -Destination $Destination -IsRoot $true
  } else {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
  }
}

function Get-VastJsonArrayCount {
  param(
    [object] $Json,
    [string] $PropertyName
  )

  if ($Json -and ($Json.PSObject.Properties.Name -contains $PropertyName)) {
    return @($Json.$PropertyName).Count
  }

  return 0
}

function Test-VastUserDataFileLooksEmpty {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $true
  }

  $name = Split-Path -Leaf $Path
  if ($name -eq 'vast-data.json') {
    $json = Read-VastJsonFile -Path $Path
    if ($null -eq $json) {
      return $false
    }

    $bookmarkCount = Get-VastJsonArrayCount -Json $json -PropertyName 'bookmarks'
    $historyCount = Get-VastJsonArrayCount -Json $json -PropertyName 'history'
    $tabCount = Get-VastJsonArrayCount -Json $json -PropertyName 'tabs'
    $downloadCount = Get-VastJsonArrayCount -Json $json -PropertyName 'downloads'
    $sessionSnapshotCount = Get-VastJsonArrayCount -Json $json -PropertyName 'sessionSnapshots'
    return ($bookmarkCount -eq 0 -and $historyCount -eq 0 -and $downloadCount -eq 0 -and $sessionSnapshotCount -eq 0 -and $tabCount -le 2)
  }

  if ($name -eq 'password-vault.json') {
    $json = Read-VastJsonFile -Path $Path
    if ($null -eq $json) {
      return $false
    }

    return ((Get-VastJsonArrayCount -Json $json -PropertyName 'records') -eq 0)
  }

  return ((Get-Item -LiteralPath $Path).Length -eq 0)
}

function Sync-VastLegacyUserData {
  param(
    [string[]] $UserDataRoots,
    [object] $Config,
    [string] $TargetVersion
  )

  if ($UserDataRoots.Count -lt 2) {
    return @()
  }

  $criticalItems = $script:VastDefaultCriticalItems
  if ($Config -and ($Config.PSObject.Properties.Name -contains 'criticalUserDataItems')) {
    $criticalItems = @($Config.criticalUserDataItems)
  }

  $migrationItems = @(
    'vast-data.json',
    'password-vault.json',
    'vast-network-devices.json',
    'Local State',
    'Preferences',
    'Network',
    'Cookies',
    'Cookies-journal',
    'Partitions',
    'IndexedDB',
    'Local Storage',
    'Session Storage',
    'Service Worker',
    'WebStorage',
    'SharedStorage',
    'Shared Dictionary',
    'DIPS',
    'Trust Tokens',
    'QuotaManager',
    'File System',
    'databases',
    'Platform Notifications'
  ) | Where-Object { $criticalItems -contains $_ }

  $canonicalRoot = $UserDataRoots[0]
  New-Item -ItemType Directory -Path $canonicalRoot -Force | Out-Null
  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $migrationBackupRoot = Join-Path (Join-Path $canonicalRoot 'Backups') ("PreLegacyUserDataMigration-$TargetVersion-$timestamp")
  $migrated = New-Object System.Collections.Generic.List[string]

  for ($i = 1; $i -lt $UserDataRoots.Count; $i++) {
    $legacyRoot = $UserDataRoots[$i]
    if (-not (Test-Path -LiteralPath $legacyRoot -PathType Container)) {
      continue
    }

    $forceMigrateLocalState = $false
    foreach ($item in $migrationItems) {
      $source = Join-Path $legacyRoot $item
      if (-not (Test-Path -LiteralPath $source)) {
        continue
      }

      $target = Join-Path $canonicalRoot $item
      $sourceIsDirectory = Test-Path -LiteralPath $source -PathType Container
      $forceMigrate = $item -eq 'Local State' -and $forceMigrateLocalState
      $targetHasContent = $false
      if (Test-Path -LiteralPath $target) {
        if (Test-Path -LiteralPath $target -PathType Container) {
          $targetHasContent = @(Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue).Count -gt 0
        } else {
          $targetHasContent = -not (Test-VastUserDataFileLooksEmpty -Path $target)
        }
      }
      if (-not $forceMigrate -and $targetHasContent) {
        Write-VastLog "Canonical user data item already has user content, skipping legacy migration for '$item'."
        continue
      }

      if (Test-Path -LiteralPath $target) {
        Copy-VastBackupItem -Source $target -Destination (Join-Path $migrationBackupRoot $item)
        if ($sourceIsDirectory) {
          Remove-Item -LiteralPath $target -Recurse -Force
        }
      }

      Copy-VastBackupItem -Source $source -Destination $target
      if ($item -eq 'password-vault.json') {
        $forceMigrateLocalState = $true
      }
      $migrated.Add($item)
      Write-VastLog "Migrated legacy user data item '$item' from '$legacyRoot' to '$canonicalRoot'."
    }
  }

  if ($migrated.Count -gt 0) {
    @{
      product = 'Vast Browser'
      targetVersion = $TargetVersion
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      migratedFiles = $migrated.ToArray()
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $migrationBackupRoot 'migration-manifest.json') -Encoding UTF8
  }

  return $migrated.ToArray()
}

function Backup-VastUserData {
  param(
    [string] $InstallPath,
    [string[]] $UserDataRoots,
    [object] $Config,
    [string] $TargetVersion,
    [string] $BackupRootPath = ''
  )

  $criticalItems = $script:VastDefaultCriticalItems
  if ($Config -and ($Config.PSObject.Properties.Name -contains 'criticalUserDataItems')) {
    $criticalItems = @($Config.criticalUserDataItems)
  }

  $optionalItems = $script:VastDefaultOptionalItems
  if ($Config -and ($Config.PSObject.Properties.Name -contains 'optionalUserDataItems')) {
    $optionalItems = @($Config.optionalUserDataItems)
  }
  $optionalItems = @($optionalItems | Where-Object { $criticalItems -notcontains $_ })

  $primaryRoot = $null
  foreach ($root in $UserDataRoots) {
    if (Test-Path -LiteralPath $root -PathType Container) {
      $primaryRoot = $root
      break
    }
  }

  if ($null -eq $primaryRoot) {
    $primaryRoot = $UserDataRoots[0]
    New-Item -ItemType Directory -Path $primaryRoot -Force | Out-Null
  }

  $backupParent = ''
  if (-not [string]::IsNullOrWhiteSpace($BackupRootPath)) {
    $backupParent = Expand-VastPath -Path $BackupRootPath
  } elseif ($Config -and ($Config.PSObject.Properties.Name -contains 'backupRoot')) {
    $backupParent = Expand-VastPath -Path ([string] $Config.backupRoot)
  }

  if ([string]::IsNullOrWhiteSpace($backupParent)) {
    $backupParent = Join-Path $primaryRoot 'Backups'
  }

  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $backupDestinationRoot = Join-Path $backupParent ("Vast-$TargetVersion-$timestamp")
  New-Item -ItemType Directory -Path $backupDestinationRoot -Force | Out-Null

  $copied = New-Object System.Collections.Generic.List[string]
  $backupErrors = New-Object System.Collections.Generic.List[string]

  for ($i = 0; $i -lt $UserDataRoots.Count; $i++) {
    $root = $UserDataRoots[$i]
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      Write-VastLog "User data root missing, skipping: $root" 'WARN'
      continue
    }

    foreach ($item in $criticalItems) {
      $source = Join-Path $root $item
      if (-not (Test-Path -LiteralPath $source)) {
        continue
      }

      $destination = Join-Path (Join-Path $backupDestinationRoot ("user-data-$($i + 1)")) $item
      try {
        Copy-VastBackupItem -Source $source -Destination $destination
        $copied.Add($source)
      } catch {
        $backupErrors.Add("$source :: $($_.Exception.Message)")
      }
    }

    foreach ($item in $optionalItems) {
      $source = Join-Path $root $item
      if (-not (Test-Path -LiteralPath $source)) {
        continue
      }

      $destination = Join-Path (Join-Path $backupDestinationRoot ("user-data-$($i + 1)")) $item
      try {
        Copy-VastBackupItem -Source $source -Destination $destination
        $copied.Add($source)
      } catch {
        Write-VastLog "Optional data backup skipped for '$source': $($_.Exception.Message)" 'WARN'
      }
    }
  }

  foreach ($item in $criticalItems) {
    $source = Join-Path $InstallPath $item
    if (-not (Test-Path -LiteralPath $source)) {
      continue
    }

    $destination = Join-Path (Join-Path $backupDestinationRoot 'install-local') $item
    try {
      Copy-VastBackupItem -Source $source -Destination $destination
      $copied.Add($source)
    } catch {
      $backupErrors.Add("$source :: $($_.Exception.Message)")
    }
  }

  $manifestPath = Join-Path $backupDestinationRoot 'backup-manifest.json'
  @{
    product = 'Vast Browser'
    targetVersion = $TargetVersion
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    copiedItems = $copied.ToArray()
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  if ($backupErrors.Count -gt 0) {
    $message = 'Critical user data backup failed: ' + ($backupErrors.ToArray() -join '; ')
    throw $message
  }

  Write-VastLog "User data backup created at '$backupDestinationRoot' with $($copied.Count) item(s)."
  return $backupDestinationRoot
}

function Copy-VastFileWithParents {
  param(
    [string] $Source,
    [string] $Destination
  )

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
}

function Backup-VastRuntimeTarget {
  param(
    [string] $InstallPath,
    [string] $RelativePath,
    [string] $RuntimeBackupRoot
  )

  $target = Join-Path $InstallPath $RelativePath
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    return $false
  }

  $backup = Join-Path $RuntimeBackupRoot $RelativePath
  Copy-VastFileWithParents -Source $target -Destination $backup
  return $true
}

function Restore-VastRuntimeBackup {
  param(
    [string] $InstallPath,
    [string] $RuntimeBackupRoot,
    [string[]] $NewFiles
  )

  Write-VastLog 'Rolling back application runtime changes.' 'WARN'

  foreach ($path in $NewFiles) {
    $target = Join-Path $InstallPath $path
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    }
  }

  if (Test-Path -LiteralPath $RuntimeBackupRoot -PathType Container) {
    $root = (Resolve-Path -LiteralPath $RuntimeBackupRoot).Path.TrimEnd('\')
    foreach ($backup in (Get-ChildItem -LiteralPath $root -File -Recurse)) {
      $relative = $backup.FullName.Substring($root.Length).TrimStart('\')
      $target = Join-Path $InstallPath $relative
      Copy-VastFileWithParents -Source $backup.FullName -Destination $target
    }
  }
}

function Write-VastInstalledVersionFile {
  param(
    [string] $InstallPath,
    [string] $TargetVersion
  )

  $versionFile = Join-Path $InstallPath 'version.json'
  @{
    product = 'Vast Browser'
    version = $TargetVersion
    channel = 'stable'
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versionFile -Encoding UTF8
}

function Copy-VastApplicationRuntime {
  param(
    [string] $InstallPath,
    [string] $PayloadPath,
    [string] $TargetVersion,
    [switch] $DryRun
  )

  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $transactionRoot = Join-Path (Join-Path $InstallPath '.vast-update') $timestamp
  $runtimeBackupRoot = Join-Path $transactionRoot 'runtime-backup'
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $runtimeBackupRoot -Force | Out-Null
  }

  $newFiles = New-Object System.Collections.Generic.List[string]
  $changedCount = 0

  try {
    foreach ($relative in (Get-VastRuntimeRelativeFiles -PayloadPath $PayloadPath)) {
      $source = Join-Path $PayloadPath $relative
      $target = Join-Path $InstallPath $relative
      $sourceHash = Get-VastFileHashString -Path $source
      $targetHash = Get-VastFileHashString -Path $target

      if ($sourceHash -eq $targetHash) {
        continue
      }

      $targetExisted = Test-Path -LiteralPath $target -PathType Leaf
      if ($targetExisted -and -not $DryRun) {
        Backup-VastRuntimeTarget -InstallPath $InstallPath -RelativePath $relative -RuntimeBackupRoot $runtimeBackupRoot | Out-Null
      } elseif (-not $targetExisted) {
        $newFiles.Add($relative)
      }

      Write-VastLog "Updating runtime file: $relative"
      if (-not $DryRun) {
        Copy-VastFileWithParents -Source $source -Destination $target
      }
      $changedCount++
    }

    $versionRelative = 'version.json'
    $versionFile = Join-Path $InstallPath $versionRelative
    if ((Test-Path -LiteralPath $versionFile -PathType Leaf) -and -not $DryRun) {
      Backup-VastRuntimeTarget -InstallPath $InstallPath -RelativePath $versionRelative -RuntimeBackupRoot $runtimeBackupRoot | Out-Null
    } elseif (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
      $newFiles.Add($versionRelative)
    }

    if (-not $DryRun) {
      Write-VastInstalledVersionFile -InstallPath $InstallPath -TargetVersion $TargetVersion
    }
    $changedCount++
  } catch {
    if (-not $DryRun) {
      Restore-VastRuntimeBackup -InstallPath $InstallPath -RuntimeBackupRoot $runtimeBackupRoot -NewFiles $newFiles.ToArray()
      throw "Runtime update failed and rollback was attempted: $($_.Exception.Message)"
    }
    throw "Runtime dry run failed without modifying application files: $($_.Exception.Message)"
  }

  Write-VastLog "Runtime update completed. Changed file count: $changedCount."
  return [pscustomobject]@{
    TransactionRoot = $transactionRoot
    RuntimeBackupRoot = $runtimeBackupRoot
    ChangedFiles = $changedCount
  }
}

function Invoke-VastUpdate {
  param(
    [string] $InstallPath = '',
    [string] $PayloadPath = '',
    [string] $UserDataRoot = '',
    [string] $BackupRoot = '',
    [string] $ConfigPath = '',
    [string] $LogPath = '',
    [string] $TargetVersion = '1.0.8',
    [string] $TargetEdition = '',
    [switch] $ForceClose,
    [switch] $NonInteractive,
    [switch] $DryRun
  )

  if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'updater.config.json'
  }

  $config = Read-VastUpdaterConfig -Path $ConfigPath
  # TargetEdition and legacy edition/targetEdition config fields are accepted
  # for older launchers and manifests, but intentionally have no effect.
  $null = $TargetEdition
  if ($config -and ($config.PSObject.Properties.Name -contains 'targetVersion') -and [string]::IsNullOrWhiteSpace($TargetVersion)) {
    $TargetVersion = [string] $config.targetVersion
  }
  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $logRoot = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($logRoot)) {
      $logRoot = $env:TEMP
    }
    $LogPath = Join-Path (Join-Path $logRoot 'Vast\UpdaterLogs') ("VastUpdater-$TargetVersion.log")
  }
  Initialize-VastLogging -Path $LogPath

  Write-VastLog "Starting Vast Browser update to $TargetVersion."
  $resolvedPayload = Resolve-VastPayloadPath -RequestedPath $PayloadPath -Config $config -ConfigPath $ConfigPath
  Test-VastPayload -PayloadPath $resolvedPayload -ExpectedVersion $TargetVersion
  Write-VastLog "Payload path: $resolvedPayload"

  $resolvedInstall = Resolve-VastInstallPath -RequestedPath $InstallPath -Config $config
  Write-VastLog "Install path: $resolvedInstall"

  $currentVersion = Get-VastInstalledVersion -InstallPath $resolvedInstall
  Write-VastLog "Detected installed version: $currentVersion"

  $versionCompare = Compare-VastSemVer $currentVersion $TargetVersion
  $operationStatus = 'Updated'
  if ($versionCompare -eq 0) {
    if (Test-VastRuntimeMatchesPayload -InstallPath $resolvedInstall -PayloadPath $resolvedPayload) {
      Write-VastLog "Installed version is already $TargetVersion and runtime files match the payload."
      if (-not $DryRun) {
        Update-VastRegistryMetadata -InstallPath $resolvedInstall -TargetVersion $TargetVersion | Out-Null
      }
      return [pscustomobject]@{
        Status = 'AlreadyCurrent'
        InstallPath = $resolvedInstall
        InstalledVersion = $currentVersion
        TargetVersion = $TargetVersion
        LogPath = $script:VastLogPath
      }
    }

    $operationStatus = 'Repaired'
    Write-VastLog "Installed version is $TargetVersion, but runtime files differ from the payload. Repairing in place." 'WARN'
  }

  if ($versionCompare -gt 0) {
    throw "Installed version '$currentVersion' is newer than target version '$TargetVersion'. Refusing to downgrade."
  }

  Test-VastWritePermission -InstallPath $resolvedInstall
  Stop-VastIfRequested -InstallPath $resolvedInstall -Config $config -Force:$ForceClose
  Test-VastLockedTargets -InstallPath $resolvedInstall -PayloadPath $resolvedPayload

  $createdBackupRoot = $null
  if ($DryRun) {
    Write-VastLog "Dry run: skipping legacy user-data migration and backup creation."
  } else {
    $userDataRoots = Get-VastUserDataRoots -RequestedUserDataRoot $UserDataRoot -Config $config
    Sync-VastLegacyUserData -UserDataRoots $userDataRoots -Config $config -TargetVersion $TargetVersion | Out-Null
    $createdBackupRoot = Backup-VastUserData -InstallPath $resolvedInstall -UserDataRoots $userDataRoots -Config $config -TargetVersion $TargetVersion -BackupRootPath $BackupRoot
  }

  $runtimeResult = Copy-VastApplicationRuntime -InstallPath $resolvedInstall -PayloadPath $resolvedPayload -TargetVersion $TargetVersion -DryRun:$DryRun
  $installedAfter = $currentVersion
  if ($DryRun) {
    Write-VastLog "Dry run completed. No runtime files were modified and installed version remains $currentVersion."
    $operationStatus = 'DryRun'
  } else {
    $installedAfter = Get-VastInstalledVersion -InstallPath $resolvedInstall
    if ((Compare-VastSemVer $installedAfter $TargetVersion) -ne 0) {
      throw "Post-update version verification failed. Expected '$TargetVersion', detected '$installedAfter'."
    }
    Update-VastRegistryMetadata -InstallPath $resolvedInstall -TargetVersion $TargetVersion | Out-Null
  }

  if ($DryRun) {
    Write-VastLog "Dry run completed successfully for target version $TargetVersion."
  } else {
    Write-VastLog "Update completed successfully. Vast Browser is now $installedAfter."
  }

  return [pscustomobject]@{
    Status = $operationStatus
    InstallPath = $resolvedInstall
    InstalledVersion = $currentVersion
    TargetVersion = $TargetVersion
    BackupPath = $createdBackupRoot
    TransactionRoot = $runtimeResult.TransactionRoot
    ChangedFiles = $runtimeResult.ChangedFiles
    LogPath = $script:VastLogPath
  }
}

if ($env:VAST_UPDATER_LIBRARY_MODE -eq '1') {
  return
}

try {
  $result = Invoke-VastUpdate `
    -InstallPath $InstallPath `
    -PayloadPath $PayloadPath `
    -UserDataRoot $UserDataRoot `
    -BackupRoot $BackupRoot `
    -ConfigPath $ConfigPath `
    -LogPath $LogPath `
    -TargetVersion $TargetVersion `
    -TargetEdition $TargetEdition `
    -ForceClose:$ForceClose `
    -NonInteractive:$NonInteractive `
    -DryRun:$DryRun

  if ($result.Status -eq 'AlreadyCurrent') {
    Write-Host "Vast Browser is already version $($result.TargetVersion). No update was needed."
  } elseif ($result.Status -eq 'DryRun') {
    Write-Host "Vast Browser dry run completed for version $($result.TargetVersion). No files were changed."
  } else {
    Write-Host "Vast Browser updated successfully to version $($result.TargetVersion)."
    Write-Host "Backup created at: $($result.BackupPath)"
  }
  Write-Host "Updater log: $($result.LogPath)"
  exit 0
} catch {
  Write-VastLog "Update failed: $($_.Exception.Message)" 'ERROR'
  Write-Host "Vast Browser update failed." -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($script:VastLogPath) {
    Write-Host "Updater log: $script:VastLogPath"
  }
  exit 1
} finally {
  if (-not $NonInteractive) {
    Write-Host ''
    Read-Host 'Press Enter to close the updater'
  }
}
