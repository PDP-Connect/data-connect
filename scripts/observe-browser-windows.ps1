# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Independent observer for the Windows hidden-native browser test. Every
# 5 ms it records whether any Chrome process started after it began owns a
# visible, uncloaked top-level window, and whether one owns the foreground
# window. Results are grouped by the phase name the test writes to
# -PhaseFile. It shares no code with the backend it observes.
#
# Usage: pwsh scripts/observe-browser-windows.ps1 -Seconds 60 -PhaseFile phase.txt

param(
  [int]$Seconds = 60,
  [Parameter(Mandatory = $true)][string]$PhaseFile
)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

public static class BrowserWindowObserver {
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  class Stats { public int Ticks, Visible, Foreground; public long FirstVisibleMs = -1; }

  public static void Run(int seconds, string phaseFile) {
    var start = DateTime.Now;
    var clock = Stopwatch.StartNew();
    var pids = new HashSet<uint>();
    var stats = new Dictionary<string, Stats>();
    var order = new List<string>();
    long lastRefresh = -1000;
    while (clock.ElapsedMilliseconds < seconds * 1000L) {
      if (clock.ElapsedMilliseconds - lastRefresh > 200) {
        foreach (var process in Process.GetProcessesByName("chrome")) {
          try { if (process.StartTime > start) pids.Add((uint)process.Id); } catch { }
        }
        lastRefresh = clock.ElapsedMilliseconds;
      }
      string phase = "start";
      try { phase = File.ReadAllText(phaseFile).Trim(); } catch { }
      if (!stats.ContainsKey(phase)) { stats[phase] = new Stats(); order.Add(phase); }
      var s = stats[phase];
      int visible = 0;
      EnumWindows((hwnd, _) => {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (!pids.Contains(pid) || GetAncestor(hwnd, 2) != hwnd || !IsWindowVisible(hwnd)) return true;
        int cloaked; DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
        RECT r; GetWindowRect(hwnd, out r);
        if (cloaked == 0 && r.Right - r.Left > 50) visible++;
        return true;
      }, IntPtr.Zero);
      uint foregroundPid; GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      s.Ticks++;
      if (visible > 0) { s.Visible++; if (s.FirstVisibleMs < 0) s.FirstVisibleMs = clock.ElapsedMilliseconds; }
      if (pids.Contains(foregroundPid)) s.Foreground++;
      Thread.Sleep(5);
    }
    Console.WriteLine("OBSERVE chrome_pids=" + string.Join(",", pids));
    foreach (var phase in order) {
      var s = stats[phase];
      Console.WriteLine("OBSERVE phase=" + phase + " ticks=" + s.Ticks + " visible_ticks=" + s.Visible +
        " foreground_ticks=" + s.Foreground + " first_visible_ms=" + (s.FirstVisibleMs < 0 ? "-" : s.FirstVisibleMs.ToString()));
    }
  }
}
"@

[BrowserWindowObserver]::Run($Seconds, $PhaseFile)
