param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
  [Parameter(Mandatory=$true)][int]$ScreenX,
  [Parameter(Mandatory=$true)][int]$ScreenY,
  [int]$Count = 90,
  [int]$IntervalMs = 18,
  [int]$WheelDelta = -120,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct VastMouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Explicit)]
public struct VastInputUnion {
    [FieldOffset(0)] public VastMouseInput mi;
}

[StructLayout(LayoutKind.Sequential)]
public struct VastInput {
    public uint type;
    public VastInputUnion union;
}

[StructLayout(LayoutKind.Sequential)]
public struct VastPoint {
    public int x;
    public int y;
}

public static class VastWinWheel {
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, VastInput[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out VastPoint point);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);

    public static int InputSize { get { return Marshal.SizeOf<VastInput>(); } }

    public static bool Wheel(int delta) {
        var input = new VastInput();
        input.type = 0;
        input.union.mi.mouseData = unchecked((uint)delta);
        input.union.mi.dwFlags = 0x0800;
        return SendInput(1, new[] { input }, InputSize) == 1;
    }
}
'@

if ([VastWinWheel]::InputSize -ne 40) { throw "Unexpected x64 INPUT size: $([VastWinWheel]::InputSize)" }
if ($SelfTest) {
  [pscustomobject]@{ ok = $true; inputSize = [VastWinWheel]::InputSize } | ConvertTo-Json -Compress
  exit 0
}
if ($Count -lt 1 -or $Count -gt 1000 -or $IntervalMs -lt 5 -or $IntervalMs -gt 1000 -or $WheelDelta -eq 0) {
  throw 'Invalid wheel-input parameters.'
}

$process = Get-Process -Id $TargetPid -ErrorAction Stop
$actualExecutable = $process.Path
if (-not [string]::Equals([System.IO.Path]::GetFullPath($actualExecutable), [System.IO.Path]::GetFullPath($ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The target PID does not belong to the expected packaged executable.'
}
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'The disposable Vast window has no native window handle.' }

$previousWindow = [VastWinWheel]::GetForegroundWindow()
$previousCursor = New-Object VastPoint
if (-not [VastWinWheel]::GetCursorPos([ref]$previousCursor)) { throw 'Could not read the current cursor position.' }
$sent = 0
$times = New-Object 'System.Collections.Generic.List[double]'
try {
  [VastWinWheel]::ShowWindowAsync($handle, 9) | Out-Null
  [VastWinWheel]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 100
  if ([VastWinWheel]::GetForegroundWindow() -ne $handle) { throw 'Windows denied foreground activation; no wheel input was sent.' }
  if (-not [VastWinWheel]::SetCursorPos($ScreenX, $ScreenY)) { throw 'Could not position the cursor over the guest.' }
  Start-Sleep -Milliseconds 100

  $watch = [Diagnostics.Stopwatch]::StartNew()
  for ($index = 0; $index -lt $Count; $index++) {
    $targetMs = $index * $IntervalMs
    while ($watch.Elapsed.TotalMilliseconds -lt $targetMs) {
      $remaining = $targetMs - $watch.Elapsed.TotalMilliseconds
      if ($remaining -gt 2) { Start-Sleep -Milliseconds ([int][Math]::Floor($remaining - 1)) }
      else { [Threading.Thread]::SpinWait(100) }
    }
    if ([VastWinWheel]::GetForegroundWindow() -ne $handle) { throw "Foreground window changed after $sent events; stopped input." }
    if (-not [VastWinWheel]::Wheel($WheelDelta)) { throw "SendInput failed after $sent events." }
    $times.Add($watch.Elapsed.TotalMilliseconds)
    $sent++
  }
  [pscustomobject]@{ ok = $true; sent = $sent; elapsedMs = $watch.Elapsed.TotalMilliseconds; timesMs = $times.ToArray() } | ConvertTo-Json -Compress
} finally {
  [VastWinWheel]::SetCursorPos($previousCursor.x, $previousCursor.y) | Out-Null
  if ($previousWindow -ne [IntPtr]::Zero -and $previousWindow -ne $handle) {
    [VastWinWheel]::SetForegroundWindow($previousWindow) | Out-Null
  }
}
