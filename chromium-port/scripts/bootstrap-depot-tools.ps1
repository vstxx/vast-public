param(
  [switch] $Update,
  [switch] $Archive
)

. (Join-Path $PSScriptRoot 'common.ps1')

$depot = Get-VastDepotTools
$revision = Read-VastChromiumRevision
Assert-VastShortPath $depot 'VAST_DEPOT_TOOLS'
$parent = Split-Path -Parent $depot
New-Item -ItemType Directory -Path $parent -Force | Out-Null
Initialize-VastGitEnvironment

if (-not (Test-Path -LiteralPath (Join-Path $depot 'gclient.bat'))) {
  if (Test-Path -LiteralPath $depot) { throw "Existing incomplete directory blocks depot_tools: $depot" }
  if ($Archive) {
    $archivePath = Join-Path $env:TEMP "vast-depot-tools-$($revision.depotToolsCommit).tar.gz"
    $uri = "https://chromium.googlesource.com/chromium/tools/depot_tools/+archive/$($revision.depotToolsCommit).tar.gz"
    New-Item -ItemType Directory -Path $depot -Force | Out-Null
    try {
      Invoke-WebRequest -Uri $uri -OutFile $archivePath -UseBasicParsing
      Invoke-VastNative 'python' @(
        (Join-Path $PSScriptRoot 'extract-gitiles-archive.py'),
        $archivePath,
        $depot
      )
      [ordered]@{
        schemaVersion = 1
        source = $uri
        commit = $revision.depotToolsCommit
        extractedAt = (Get-Date).ToUniversalTime().ToString('o')
      } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $depot '.vast-depot-tools-archive.json') -Encoding utf8
    } finally {
      Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    }
  } else {
    Invoke-VastNative 'git' @('clone', '--depth=1', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git', $depot)
  }
} elseif ($Update -and (Test-Path -LiteralPath (Join-Path $depot '.git'))) {
  Invoke-VastNative 'git' @('-C', $depot, 'pull', '--ff-only')
} elseif ($Update) {
  throw 'Archive-based depot_tools cannot self-update. Move it aside and bootstrap the new pinned archive.'
}

$winTools = Join-Path $depot 'bootstrap\win_tools.bat'
if (-not (Test-Path -LiteralPath (Join-Path $depot 'git.bat') -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath $winTools -PathType Leaf)) { throw "Missing depot_tools Windows bootstrap: $winTools" }
  $bootstrapCommand = "set PATH=$depot;%PATH%&&set DEPOT_TOOLS_WIN_TOOLCHAIN=0&&set DEPOT_TOOLS_UPDATE=0&&call `"$winTools`""
  Invoke-VastNative 'cmd.exe' @('/d', '/c', $bootstrapCommand) $parent
}

$command = "set PATH=$depot;%PATH%&&set DEPOT_TOOLS_WIN_TOOLCHAIN=0&&set DEPOT_TOOLS_UPDATE=0&&call gclient.bat"
Invoke-VastNative 'cmd.exe' @('/d', '/c', $command) $parent
Write-Host "depot_tools ready: $depot"
