# Raises the largest visible top-level window of a process tree above every
# other window (topmost) so Chromium's occlusion tracking keeps it visible
# during a measurement. Every target gets the same treatment.
param([Parameter(Mandatory = $true)][int]$RootPid)
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class HeavyWebFront {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Largest(HashSet<uint> pids) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) { RECT r; GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T); if (a > area) { area = a; best = h; } }
      return true; }, IntPtr.Zero);
    return best;
  }
}
'@
$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
$ids = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$ids.Add([uint32]$RootPid)
$changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $changed = $true } } }
$h = [HeavyWebFront]::Largest($ids)
if ($h -eq [IntPtr]::Zero) { Write-Output 'no-window'; exit 1 }
# A z-order change alone does not make Chromium recompute occlusion; a 1 px
# move and back raises the location-change events it listens to.
$r = New-Object HeavyWebFront+RECT
[void][HeavyWebFront]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
[void][HeavyWebFront]::SetWindowPos($h, [IntPtr](-1), $r.L, $r.T + 1, $w, $ht, 0x0040)
Start-Sleep -Milliseconds 50
[void][HeavyWebFront]::SetWindowPos($h, [IntPtr](-1), $r.L, $r.T, $w, $ht, 0x0040)
[HeavyWebFront]::SwitchToThisWindow($h, $true)
[void][HeavyWebFront]::SetForegroundWindow($h)
Write-Output "raised $h"
