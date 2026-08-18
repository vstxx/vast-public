param([switch] $FailIfNewer)

. (Join-Path $PSScriptRoot 'common.ps1')
$current = Read-VastChromiumRevision
$releases = Invoke-RestMethod -Uri 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1'
$latest = @($releases)[0]
[ordered]@{
  pinned = $current.version
  latestWindowsStable = $latest.version
  updateAvailable = ([version]$latest.version -gt [version]$current.version)
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json
if ($FailIfNewer -and [version]$latest.version -gt [version]$current.version) { exit 3 }
