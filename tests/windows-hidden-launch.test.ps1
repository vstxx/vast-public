param(
  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,
  [int] $TimeoutSeconds = 45
)

# The 0.5.0 updater relaunches Vast with Start-Process -WindowStyle Hidden.
# Windows applies that to the first window shown, so 0.5.4 stayed invisible
# after every automatic update. Launch the packaged app the same way, with a
# disposable profile, and require a visible browser window.
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ("vast-hidden-launch-" + [guid]::NewGuid())
$profileEnv = @{ APPDATA = (Join-Path $root 'appdata'); LOCALAPPDATA = (Join-Path $root 'local'); PORTABLE_EXECUTABLE_DIR = (Join-Path $root 'portable') }
foreach ($dir in $profileEnv.Values) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class VastHiddenLaunchProbe {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  public static int VisibleVastWindows(uint pid) {
    int count = 0;
    EnumWindows((hwnd, l) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid && IsWindowVisible(hwnd)) { var title = new StringBuilder(256); GetWindowText(hwnd, title, 256); if (title.ToString() == "Vast") count++; }
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
"@

$saved = @{}
foreach ($name in $profileEnv.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $profileEnv[$name]) }
$savedRunAsNode = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$process = $null
try {
  $process = Start-Process -FilePath $exe -ArgumentList '--vast-after-update' -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $visible = 0
  while ((Get-Date) -lt $deadline -and $visible -eq 0) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "Vast exited with code $($process.ExitCode) after a hidden launch." }
    $visible = [VastHiddenLaunchProbe]::VisibleVastWindows([uint32]$process.Id)
  }
  if ($visible -eq 0) { throw "No visible Vast window $TimeoutSeconds s after a hidden launch (the updater's relaunch)." }
  Write-Host "Hidden launch shows the Vast window."
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  if ($null -ne $savedRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $savedRunAsNode }
  Get-CimInstance Win32_Process -Filter "Name='$(Split-Path $exe -Leaf)'" | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
