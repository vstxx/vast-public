Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:PortRoot = Split-Path -Parent $PSScriptRoot
$script:RepositoryRoot = Split-Path -Parent $script:PortRoot

function Get-VastRepositoryRoot {
  return $script:RepositoryRoot
}

function Get-VastPortRoot {
  return $script:PortRoot
}

function Read-VastChromiumRevision {
  $path = Join-Path $script:PortRoot 'revision.json'
  $revision = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if (
    $revision.schemaVersion -ne 1 -or
    $revision.commit -notmatch '^[0-9a-f]{40}$' -or
    $revision.depotToolsCommit -notmatch '^[0-9a-f]{40}$' -or
    $revision.windowsSdk.servicingVersion -notmatch '^10\.0\.\d+\.\d+$' -or
    $revision.windowsSdk.isoSha256 -notmatch '^[0-9A-F]{64}$' -or
    $revision.windowsSdk.midlX64Sha256 -notmatch '^[0-9A-F]{64}$' -or
    $revision.windowsSdk.cdbX64Sha256 -notmatch '^[0-9A-F]{64}$'
  ) {
    throw "Invalid Chromium revision metadata: $path"
  }
  return $revision
}

function Get-VastChromiumSrc {
  $value = if ($env:VAST_CHROMIUM_SRC) { $env:VAST_CHROMIUM_SRC } else { 'C:\Chromium\src' }
  return [System.IO.Path]::GetFullPath($value)
}

function Get-VastDepotTools {
  $value = if ($env:VAST_DEPOT_TOOLS) { $env:VAST_DEPOT_TOOLS } else { 'C:\Chromium\depot_tools' }
  return [System.IO.Path]::GetFullPath($value)
}

function Get-VastChromiumOut {
  $value = if ($env:VAST_CHROMIUM_OUT) { $env:VAST_CHROMIUM_OUT } else { 'out\VastDev' }
  if ([System.IO.Path]::IsPathRooted($value)) {
    throw 'VAST_CHROMIUM_OUT must be relative to the Chromium src directory.'
  }
  return $value.Replace('/', '\')
}

function Get-VastChromiumArtifactRoot {
  if ($env:VAST_CHROMIUM_ARTIFACTS) {
    return [System.IO.Path]::GetFullPath($env:VAST_CHROMIUM_ARTIFACTS)
  }
  return Join-Path (Split-Path -Parent (Get-VastChromiumSrc)) 'artifacts'
}

function Get-VastWindowsSdkRoot {
  $value = if ($env:VAST_WINDOWS_SDK_ROOT) {
    $env:VAST_WINDOWS_SDK_ROOT
  } else {
    'C:\Chromium\sdk-7705\Windows Kits\10'
  }
  return [System.IO.Path]::GetFullPath($value)
}

function Get-VastWindowsSdkX64Tools {
  $revision = Read-VastChromiumRevision
  return Join-Path (Get-VastWindowsSdkRoot) "bin\$($revision.windowsSdk.folderVersion)\x64"
}

function Assert-VastShortPath([string] $Path, [string] $Label) {
  if ($Path.Contains(' ')) {
    throw "$Label must not contain spaces: $Path"
  }
  $root = [System.IO.Path]::GetPathRoot($Path)
  if (-not $root) {
    throw "$Label must be an absolute path: $Path"
  }
}

function Get-VastVsWhere {
  $path = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "vswhere.exe was not found at $path"
  }
  return $path
}

function Find-VastVisualStudio2026 {
  try {
    $vswhere = Get-VastVsWhere
    $path = & $vswhere -products * -version '[18.0,19.0)' -requires Microsoft.VisualStudio.Workload.NativeDesktop Microsoft.VisualStudio.Component.VC.ATLMFC -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $path) { return $null }
    return ($path | Select-Object -First 1).Trim()
  } catch {
    return $null
  }
}

function Initialize-VastGitEnvironment {
  $checkoutRoot = Split-Path -Parent (Get-VastChromiumSrc)
  New-Item -ItemType Directory -Path $checkoutRoot -Force | Out-Null
  $config = Join-Path $checkoutRoot '.vast-gitconfig'
  foreach ($setting in @(
    @('core.autocrlf', 'false'),
    @('core.filemode', 'false'),
    @('core.fscache', 'true'),
    @('core.preloadindex', 'true'),
    @('core.longpaths', 'true'),
    @('http.version', 'HTTP/1.1'),
    @('http.maxRequests', '4'),
    @('depot-tools.allowGlobalGitConfig', 'false')
  )) {
    & git config --file $config $setting[0] $setting[1]
    if ($LASTEXITCODE -ne 0) { throw "Could not write isolated Chromium Git config: $config" }
  }
  $env:GIT_CONFIG_GLOBAL = $config
}

function Initialize-VastDepotEnvironment {
  Initialize-VastGitEnvironment
  $depot = Get-VastDepotTools
  Assert-VastShortPath $depot 'VAST_DEPOT_TOOLS'
  if (-not (Test-Path -LiteralPath (Join-Path $depot 'gclient.bat') -PathType Leaf)) {
    throw "depot_tools is not initialized at $depot"
  }
  $env:PATH = "$depot;$env:PATH"
  $env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
  $env:DEPOT_TOOLS_UPDATE = '0'
  $vs2026 = Find-VastVisualStudio2026
  if ($vs2026) { $env:vs2026_install = $vs2026 }
}

function Invoke-VastNative([string] $Command, [string[]] $Arguments, [string] $WorkingDirectory = '') {
  if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Command exited with code $LASTEXITCODE"
    }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Invoke-VastNativeWithRetry(
  [string] $Command,
  [string[]] $Arguments,
  [string] $WorkingDirectory = '',
  [int] $Attempts = 5
) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
      Invoke-VastNative $Command $Arguments $WorkingDirectory
      return
    } catch {
      if ($attempt -eq $Attempts) { throw }
      $delaySeconds = [math]::Min(60, 5 * [math]::Pow(2, $attempt - 1))
      Write-Warning "$Command attempt $attempt/$Attempts failed: $($_.Exception.Message). Retrying in $delaySeconds seconds."
      Start-Sleep -Seconds $delaySeconds
    }
  }
}

function Invoke-VastPatchSeriesIndexCheck(
  [string] $SourcePath,
  [object[]] $PatchEntries,
  [string] $PatchRoot,
  [switch] $ReverseCurrentTree
) {
  $temporaryIndex = Join-Path ([System.IO.Path]::GetTempPath()) "vast-patch-$PID-$([guid]::NewGuid().ToString('N')).index"
  $previousIndex = $env:GIT_INDEX_FILE
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $env:GIT_INDEX_FILE = $temporaryIndex
    $ErrorActionPreference = 'SilentlyContinue'
    & git -C $SourcePath read-tree HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }

    if ($ReverseCurrentTree) {
      & git -C $SourcePath add -A 2>$null
      if ($LASTEXITCODE -ne 0) { return $false }
      $orderedEntries = $PatchEntries.Clone()
      [array]::Reverse($orderedEntries)
    } else {
      $orderedEntries = $PatchEntries.Clone()
    }

    foreach ($entry in $orderedEntries) {
      $patch = Join-Path $PatchRoot $entry.file
      $arguments = @('apply', '--cached', '--check')
      if ($ReverseCurrentTree) { $arguments += '--reverse' }
      $arguments += $patch
      & git -C $SourcePath @arguments 2>$null
      if ($LASTEXITCODE -ne 0) { return $false }

      $arguments = @('apply', '--cached')
      if ($ReverseCurrentTree) { $arguments += '--reverse' }
      $arguments += $patch
      & git -C $SourcePath @arguments 2>$null
      if ($LASTEXITCODE -ne 0) { return $false }
    }
    return $true
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -eq $previousIndex) {
      Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    } else {
      $env:GIT_INDEX_FILE = $previousIndex
    }
    Remove-Item -LiteralPath $temporaryIndex -Force -ErrorAction SilentlyContinue
  }
}

function Test-VastPatchSeriesAppliesToHead(
  [string] $SourcePath,
  [object[]] $PatchEntries,
  [string] $PatchRoot
) {
  return Invoke-VastPatchSeriesIndexCheck $SourcePath $PatchEntries $PatchRoot
}

function Test-VastPatchSeriesApplied(
  [string] $SourcePath,
  [object[]] $PatchEntries,
  [string] $PatchRoot
) {
  return Invoke-VastPatchSeriesIndexCheck $SourcePath $PatchEntries $PatchRoot -ReverseCurrentTree
}

function New-VastReportPath([string] $Name) {
  $directory = Join-Path $script:PortRoot '.reports'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return Join-Path $directory "$Name-$stamp.json"
}
