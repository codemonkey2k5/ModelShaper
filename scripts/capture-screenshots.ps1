# Maximize, click header Help/Settings and Back to workflow, capture full window.
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DpiBoot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiBoot]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;

public class Shot {
  public const int SW_MAXIMIZE = 3;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const int MOUSEEVENTF_LEFTDOWN = 0x02;
  public const int MOUSEEVENTF_LEFTUP = 0x04;
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int c, int dwExtra);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static RECT Bounds(IntPtr hWnd) {
    RECT r;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
      GetWindowRect(hWnd, out r);
    return r;
  }
  public static void Maximize(IntPtr hWnd) {
    ShowWindow(hWnd, SW_MAXIMIZE);
    SetForegroundWindow(hWnd);
  }
  public static void ClickOn(IntPtr hWnd, int x, int y) {
    SetForegroundWindow(hWnd);
    System.Threading.Thread.Sleep(150);
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(100);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(50);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }
  public static void Capture(IntPtr hWnd, string path) {
    if (!IsZoomed(hWnd)) throw new Exception("not maximized");
    SetForegroundWindow(hWnd);
    System.Threading.Thread.Sleep(500);
    RECT r = Bounds(hWnd);
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp))
        g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      Console.WriteLine("size=" + w + "x" + h);
      bmp.Save(path, ImageFormat.Png);
    }
  }
  public static void Scale(string src, string dest, int maxW) {
    using (var img = Image.FromFile(src)) {
      int w = img.Width, h = img.Height;
      if (w > maxW) { h = (int)Math.Round(h * (maxW / (double)w)); w = maxW; }
      using (var outB = new Bitmap(w, h))
      using (var g = Graphics.FromImage(outB)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(img, 0, 0, w, h);
        outB.Save(dest, ImageFormat.Png);
      }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing.dll

function Get-Hwnd {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name "ModelShaper","modelshaper" -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Select-Object -First 1
    if ($p) { return $p.MainWindowHandle }
    Start-Sleep -Milliseconds 300
  }
  throw "ModelShaper window not found"
}

function Save-Shot([IntPtr]$hwnd, [string]$basename) {
  [Shot]::Maximize($hwnd)
  Start-Sleep -Seconds 1
  if (-not [Shot]::IsZoomed($hwnd)) {
    [Shot]::Maximize($hwnd)
    Start-Sleep -Seconds 1
  }
  $full = Join-Path $fullDir "$basename.png"
  $web = Join-Path $webDir "$basename.png"
  [Shot]::Capture($hwnd, $full)
  [Shot]::Scale($full, $web, 1920)
  Write-Output "Saved $basename"
}

$root = "C:\Temp\GrokBuild\ModelShaper"
$exeSrc = Join-Path $root "deliverables\ModelShaper.exe"
if (-not (Test-Path $exeSrc)) {
  $exeSrc = Join-Path $root "src-tauri\target\release\modelshaper.exe"
}
$fullDir = Join-Path $root "docs\screenshots\full-res"
$webDir = Join-Path $root "docs\screenshots"
New-Item -ItemType Directory -Force -Path $fullDir, $webDir | Out-Null

$work = "F:\ModelShaper\New folder"
if (-not (Test-Path $work)) {
  $work = Join-Path $env:TEMP "ms_screenshot_run"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
}
Copy-Item -Force $exeSrc (Join-Path $work "ModelShaper.exe")
Remove-Item (Join-Path $work "_start_view.txt") -Force -ErrorAction SilentlyContinue

Get-Process -Name "ModelShaper","modelshaper" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$proc = Start-Process -FilePath (Join-Path $work "ModelShaper.exe") -WorkingDirectory $work -PassThru
Write-Output "Launched $($proc.Id) from $work"
Start-Sleep -Seconds 14
$hwnd = Get-Hwnd
[Shot]::Maximize($hwnd)
Start-Sleep -Seconds 2
$r = [Shot]::Bounds($hwnd)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output "Window $w x $h"

$headerY = $r.Top + [int]($h * 0.04)
$helpX = $r.Left + [int]($w * 0.93)
$settingsX = $r.Left + [int]($w * 0.975)
$backX = $r.Left + [int]($w * 0.09)
$backY = $r.Top + [int]($h * 0.11)

# Open Help, capture
Write-Output "Click Help"
[Shot]::ClickOn($hwnd, $helpX, $headerY)
Start-Sleep -Seconds 2
Save-Shot $hwnd "02-help"

# Open Settings, capture
Write-Output "Click Settings"
[Shot]::ClickOn($hwnd, $settingsX, $headerY)
Start-Sleep -Seconds 2
Save-Shot $hwnd "03-settings"

# Back to workflow / system check
Write-Output "Click Back to workflow"
[Shot]::ClickOn($hwnd, $backX, $backY)
Start-Sleep -Seconds 2
# If setup is showing, click Look around first / Continue region
$cy = $r.Top + [int]($h * 0.62)
[Shot]::ClickOn($hwnd, ($r.Left + [int]($w * 0.50)), $cy)
Start-Sleep -Seconds 1
[Shot]::ClickOn($hwnd, ($r.Left + [int]($w * 0.62)), $cy)
Start-Sleep -Seconds 2
[Shot]::ClickOn($hwnd, $backX, $backY)
Start-Sleep -Seconds 2
Save-Shot $hwnd "01-system-check"

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name "ModelShaper","modelshaper" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Output "DONE"
Get-ChildItem $webDir -Filter "*.png" | Select-Object Name, Length
Get-ChildItem $fullDir -Filter "*.png" | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  Write-Output ("FULL {0} {1}x{2}" -f $_.Name, $img.Width, $img.Height)
  $img.Dispose()
}
