param(
  [switch] $AllowIncomplete,
  [string] $ReportPath
)

. (Join-Path $PSScriptRoot 'common.ps1')

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string] $Name, [bool] $Ok, [string] $Detail, [bool] $Required = $true) {
  $checks.Add([pscustomobject][ordered]@{ name = $Name; ok = $Ok; required = $Required; detail = $Detail })
}

$src = Get-VastChromiumSrc
$depot = Get-VastDepotTools
$revision = Read-VastChromiumRevision

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Add-Check 'Windows x64' (($os.OSArchitecture -match '64') -and [Environment]::OSVersion.Version.Major -ge 10) "$($os.Caption) $($os.Version), $($os.OSArchitecture)"
Add-Check 'RAM >= 16 GB' ($computer.TotalPhysicalMemory -ge 16GB) ("{0:N1} GB" -f ($computer.TotalPhysicalMemory / 1GB))
Add-Check 'Logical processors' ($computer.NumberOfLogicalProcessors -ge 8) "$($cpu.Name), $($computer.NumberOfLogicalProcessors) logical processors" $false

$driveName = ([System.IO.Path]::GetPathRoot($src)).TrimEnd('\').TrimEnd(':')
$drive = Get-PSDrive -Name $driveName
$volume = Get-Volume -DriveLetter $driveName
Add-Check 'Chromium volume is NTFS' ($volume.FileSystem -eq 'NTFS') "$($volume.DriveLetter): $($volume.FileSystem)"
Add-Check 'Chromium volume has >= 150 GB free' ($drive.Free -ge 150GB) ("{0:N1} GB free" -f ($drive.Free / 1GB))
Add-Check 'Chromium source path has no spaces' (-not $src.Contains(' ')) $src
Add-Check 'depot_tools path has no spaces' (-not $depot.Contains(' ')) $depot

$longPaths = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
Add-Check 'Windows long paths' ($longPaths -eq 1) "LongPathsEnabled=$longPaths; short checkout path is required while disabled" $false

$git = Get-Command git -ErrorAction SilentlyContinue
Add-Check 'Git' ($null -ne $git) $(if ($git) { (& git --version) } else { 'not found' })

$vs2026 = Find-VastVisualStudio2026
Add-Check 'Visual Studio 2026 Desktop C++ + ATL/MFC' ($null -ne $vs2026) $(if ($vs2026) { $vs2026 } else { 'required VS 2026 workload/components not found' })

$sdk = Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Get-ItemProperty |
  Where-Object {
    $_.PSObject.Properties.Name -contains 'DisplayName' -and
    $_.PSObject.Properties.Name -contains 'DisplayVersion' -and
    $_.DisplayName -eq 'Windows SDK' -and
    $_.DisplayVersion -eq '10.1.26100.7705'
  } |
  Select-Object -First 1
Add-Check 'Machine-wide Windows SDK registration' ($null -ne $sdk) $(if ($sdk) { $sdk.DisplayVersion } else { 'exact registration not found; isolated tools are checked separately' }) $false

$pinnedMidl = Join-Path (Get-VastWindowsSdkX64Tools) 'midl.exe'
$pinnedMidlOk = $false
$pinnedMidlDetail = "missing: $pinnedMidl"
if (Test-Path -LiteralPath $pinnedMidl -PathType Leaf) {
  $pinnedMidlHash = (Get-FileHash -LiteralPath $pinnedMidl -Algorithm SHA256).Hash
  $pinnedMidlVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($pinnedMidl).FileVersion
  $pinnedMidlSignature = Get-AuthenticodeSignature -LiteralPath $pinnedMidl
  $pinnedMidlOk = (
    $pinnedMidlHash -eq $revision.windowsSdk.midlX64Sha256 -and
    $pinnedMidlVersion -like "$($revision.windowsSdk.servicingVersion)*" -and
    $pinnedMidlSignature.Status -eq 'Valid' -and
    $pinnedMidlSignature.SignerCertificate.Subject -match 'CN=Microsoft Corporation'
  )
  $pinnedMidlDetail = "$pinnedMidlVersion, SHA-256 $pinnedMidlHash, signature $($pinnedMidlSignature.Status)"
}
Add-Check 'Pinned Windows SDK x64 tools' $pinnedMidlOk $pinnedMidlDetail

$globalCdb = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
$isolatedCdb = Join-Path (Get-VastWindowsSdkRoot) 'Debuggers\x64\cdb.exe'
$cdb = if (Test-Path -LiteralPath $isolatedCdb -PathType Leaf) { $isolatedCdb } else { $globalCdb }
$cdbOk = Test-Path -LiteralPath $cdb -PathType Leaf
$cdbDetail = $cdb
if ($cdbOk -and $cdb -eq $isolatedCdb) {
  $cdbHash = (Get-FileHash -LiteralPath $cdb -Algorithm SHA256).Hash
  $cdbVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($cdb).FileVersion
  $cdbSignature = Get-AuthenticodeSignature -LiteralPath $cdb
  $cdbOk = (
    $cdbHash -eq $revision.windowsSdk.cdbX64Sha256 -and
    $cdbVersion -like "$($revision.windowsSdk.servicingVersion)*" -and
    $cdbSignature.Status -eq 'Valid' -and
    $cdbSignature.SignerCertificate.Subject -match 'CN=Microsoft Corporation'
  )
  $cdbDetail = "$cdbVersion, SHA-256 $cdbHash, signature $($cdbSignature.Status)"
}
Add-Check 'Windows SDK Debugging Tools' $cdbOk $cdbDetail

$gclient = Join-Path $depot 'gclient.bat'
$depotGit = Join-Path $depot 'git.bat'
Add-Check 'depot_tools' (
  (Test-Path -LiteralPath $gclient -PathType Leaf) -and
  (Test-Path -LiteralPath $depotGit -PathType Leaf)
) "$depot (gclient.bat and git.bat)"
Add-Check 'Pinned Chromium metadata' $true "$($revision.version) @ $($revision.commit)"

$failed = @($checks | Where-Object { $_.required -and -not $_.ok })
$report = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  chromiumSource = $src
  depotTools = $depot
  ready = ($failed.Count -eq 0)
  checks = $checks
}
if (-not $ReportPath) { $ReportPath = New-VastReportPath 'preflight' }
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8

$checks | Format-Table @{N='State';E={if ($_.ok) {'PASS'} elseif ($_.required) {'FAIL'} else {'WARN'}}}, name, detail -AutoSize
Write-Host "Report: $ReportPath"
if ($failed.Count -gt 0 -and -not $AllowIncomplete) { exit 2 }
