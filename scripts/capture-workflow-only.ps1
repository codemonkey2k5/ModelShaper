# Launch with a clean env (no MODELSHAPER_START_VIEW), capture main workflow.
$ErrorActionPreference = "Stop"
Remove-Item Env:MODELSHAPER_START_VIEW -Force -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("MODELSHAPER_START_VIEW", $null, "Process")

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
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static RECT Bounds(IntPtr hWnd) {
    RECT r;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
      GetWindowRect(hWnd, out r);
    return r;
  }
  public static void Maximize(IntPtr hWnd) { ShowWindow(hWnd, SW_MAXIMIZE); SetForegroundWindow(hWnd); }
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

$work = "F:\ModelShaper\New folder"
$full = "C:\Temp\GrokBuild\ModelShaper\docs\screenshots\full-res"
$web = "C:\Temp\GrokBuild\ModelShaper\docs\screenshots"
Get-Process ModelShaper,modelshaper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Copy-Item -Force "C:\Temp\GrokBuild\ModelShaper\deliverables\ModelShaper.exe" "$work\ModelShaper.exe"
Set-Content -Path "$work\_start_view.txt" -Value "wizard" -Encoding ascii

$p = Start-Process "$work\ModelShaper.exe" -WorkingDirectory $work -PassThru
Start-Sleep 16

$hwnd = $null
foreach ($i in 1..50) {
  $proc = Get-Process ModelShaper -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($proc) { $hwnd = $proc.MainWindowHandle; break }
  Start-Sleep -Milliseconds 400
}
if (-not $hwnd) { throw "no window" }

[Shot]::Maximize($hwnd)
Start-Sleep 3
[Shot]::Capture($hwnd, "$full\01-system-check.png")
[Shot]::Scale("$full\01-system-check.png", "$web\01-system-check.png", 1920)
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Write-Output "DONE"
