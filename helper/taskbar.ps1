<#
.SYNOPSIS
  Taskbar progress / window restore helper for DeepSeek Harness.

.DESCRIPTION
  Runs once per state change. Finds the Electron main window of the process
  that launched the Host (the Host's parent process id) and then either sets
  the taskbar button to an indeterminate progress state, clears it, or brings
  the window back to the foreground.

  The window is addressed by its handle, so the shell's ITaskbarList3 object is
  created in this helper process: the Electron main process does not need to be
  modified or instrumented.

.PARAMETER ParentPid
  Process id of the Electron main process (the Host's parent).

.PARAMETER Action
  INDETERMINATE, NONE, or FOCUS.
#>
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Action
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DshAttentionTaskbar
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
    private class TaskbarList
    {
    }

    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
        void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
        void SetProgressState(IntPtr hwnd, int flags);
    }

    public static IntPtr FindMainWindow(int parentPid)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if ((int)processId != parentPid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            StringBuilder title = new StringBuilder(512);
            if (GetWindowText(hwnd, title, 512) == 0) return true;
            StringBuilder className = new StringBuilder(256);
            GetClassName(hwnd, className, 256);
            if (className.ToString() != "Chrome_WidgetWin_1") return true;
            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) return true;
            long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
            if (area > bestArea)
            {
                bestArea = area;
                best = hwnd;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static void SetProgress(IntPtr hwnd, int flags)
    {
        ITaskbarList3 list = (ITaskbarList3)new TaskbarList();
        list.HrInit();
        list.SetProgressState(hwnd, flags);
    }

    public static void Focus(IntPtr hwnd)
    {
        ShowWindow(hwnd, 9);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
    }
}
"@

$hwnd = [DshAttentionTaskbar]::FindMainWindow($ParentPid)
if ($hwnd -eq [IntPtr]::Zero) {
  exit 0
}

switch ($Action) {
  'INDETERMINATE' { [DshAttentionTaskbar]::SetProgress($hwnd, 1) }
  'NONE' { [DshAttentionTaskbar]::SetProgress($hwnd, 0) }
  'FOCUS' { [DshAttentionTaskbar]::Focus($hwnd) }
}

exit 0
