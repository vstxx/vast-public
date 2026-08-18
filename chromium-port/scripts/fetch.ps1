param([switch] $AllowDirty)

. (Join-Path $PSScriptRoot 'common.ps1')

$src = Get-VastChromiumSrc
$depot = Get-VastDepotTools
$revision = Read-VastChromiumRevision
Assert-VastShortPath $src 'VAST_CHROMIUM_SRC'
Initialize-VastDepotEnvironment

if ((Split-Path -Leaf $src) -ne 'src') { throw 'The fetch workflow requires VAST_CHROMIUM_SRC to end in \src.' }
$checkoutRoot = Split-Path -Parent $src
New-Item -ItemType Directory -Path $checkoutRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $src '.git'))) {
  if (Test-Path -LiteralPath $src) { throw "Existing non-Git directory blocks Chromium checkout: $src" }
  if (-not (Test-Path -LiteralPath (Join-Path $checkoutRoot '.gclient') -PathType Leaf)) {
    # Current fetch.py parses options before its variadic config argument.
    $fetchCommand = "set PATH=$depot;%PATH%&&set DEPOT_TOOLS_WIN_TOOLCHAIN=0&&set DEPOT_TOOLS_UPDATE=0&&call fetch.bat --no-history chromium"
    try {
      Invoke-VastNative 'cmd.exe' @('/d', '/c', $fetchCommand) $checkoutRoot
    } catch {
      if (-not (Test-Path -LiteralPath (Join-Path $checkoutRoot '.gclient') -PathType Leaf)) { throw }
      Write-Warning "Initial fetch was interrupted after creating .gclient; resuming with gclient sync."
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $src '.git'))) {
    Invoke-VastNativeWithRetry 'gclient.bat' @('sync', '--no-history', '--jobs', '4') $checkoutRoot
  }
} elseif (-not $AllowDirty) {
  $status = & git -C $src status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Chromium checkout.' }
  if ($status) { throw 'Chromium checkout has tracked changes. Refusing to change revisions; export/revert the Vast patch work first.' }
}

Invoke-VastNativeWithRetry 'git' @('-C', $src, 'fetch', '--depth=1', 'origin', "refs/tags/$($revision.version):refs/tags/$($revision.version)")
Invoke-VastNative 'git' @('-C', $src, 'checkout', '--detach', $revision.commit)
Invoke-VastNativeWithRetry 'gclient.bat' @('sync', '-D', '--force', '--no-history', '--jobs', '4', '--revision', "src@$($revision.commit)") $src

$actual = (& git -C $src rev-parse HEAD).Trim()
if ($actual -ne $revision.commit) { throw "Checkout mismatch: expected $($revision.commit), got $actual" }
Write-Host "Chromium ready: $($revision.version) @ $actual"
