param([Parameter(Mandatory = $true)][string] $Executable)

$ErrorActionPreference = 'Stop'
$info = (Get-Item -LiteralPath $Executable -ErrorAction Stop).VersionInfo
[ordered]@{
  fileDescription = [string] $info.FileDescription
  productName = [string] $info.ProductName
  fileVersion = [string] $info.FileVersion
  productVersion = [string] $info.ProductVersion
} | ConvertTo-Json -Compress
