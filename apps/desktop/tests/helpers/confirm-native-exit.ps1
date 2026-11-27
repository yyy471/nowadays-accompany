param([int]$TargetProcess)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Stage4Dialog {
  public delegate bool Visit(IntPtr hwnd, IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, Visit visit, IntPtr context);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  static string Read(IntPtr hwnd, bool title) {
    var text = new StringBuilder(512);
    if (title) GetWindowText(hwnd, text, text.Capacity); else GetClassName(hwnd, text, text.Capacity);
    return text.ToString();
  }
  public static bool Click(int pid, string label, bool diagnose) {
    bool clicked = false;
    EnumWindows((window, ignored) => {
      uint id;
      GetWindowThreadProcessId(window, out id);
      if (id != pid) return true;
      if (diagnose) Console.WriteLine("Stage4 window " + Read(window,false) + " " + Read(window,true));
      if (Read(window,false) != "#32770") return true;
      EnumChildWindows(window, (button, unused) => {
        string title = Read(button,true);
        if (diagnose) Console.WriteLine("Stage4 child " + Read(button,false) + " " + title);
        if (Read(button,false) != "Button" || title.Replace("&","") != label) return true;
        clicked = PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);
        return !clicked;
      },IntPtr.Zero);
      return !clicked;
    },IntPtr.Zero);
    return clicked;
  }
}
"@
$label = -join ([char[]](0x653e,0x5f03,0x4fee,0x6539,0x5e76,0x9000,0x51fa))
for ($attempt = 0; $attempt -lt 70; $attempt++) {
  if ([Stage4Dialog]::Click($TargetProcess, $label, $attempt -eq 12)) { exit 0 }
  Start-Sleep -Milliseconds 100
}
throw 'STAGE4_NATIVE_BUTTON_NOT_FOUND'
