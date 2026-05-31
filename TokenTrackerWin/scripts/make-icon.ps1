# ──────────────────────────────────────────────
# make-icon.ps1
# Generates assets/trayicon.ico — the official TokenTracker app mark: a black
# rounded square with the white lightning bolt, rendered from the real
# AppIcon path (TokenTrackerBar/.../AppIcon.icon/Assets/02-bolt.svg, bg #000000).
# Used as the Windows app icon (exe + window/taskbar). The tray uses the
# separate Clawd mascot icons (see make-tray-mascot.ps1).
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
# ──────────────────────────────────────────────
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AssetsDir = Join-Path (Split-Path -Parent $ScriptDir) 'assets'
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null
$OutPath = Join-Path $AssetsDir 'trayicon.ico'

# White bolt path from AppIcon.icon/Assets/02-bolt.svg (viewBox 0 0 1024 1024).
$boltPath = 'M297.714 590.108 C257.738 590.108 235.231 544.152 259.741 512.570 L468.978 242.978 C483.016 224.891 511.998 234.818 511.998 257.714 L511.998 433.891 L726.279 433.891 C766.256 433.891 788.761 479.848 764.251 511.428 L555.015 781.022 C540.977 799.109 511.998 789.181 511.998 766.285 L511.998 590.108 L297.714 590.108 Z'

function New-Pt([single]$x, [single]$y) { New-Object System.Drawing.PointF($x, $y) }

function Build-Bolt([single]$scale) {
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cur = New-Pt 0 0
    foreach ($m in [regex]::Matches($boltPath, '([MLCZ])([^MLCZ]*)')) {
        $cmd = $m.Groups[1].Value
        $n = @([regex]::Matches($m.Groups[2].Value, '-?\d+(?:\.\d+)?') | ForEach-Object { [single]$_.Value * $scale })
        switch ($cmd) {
            'M' { $cur = New-Pt $n[0] $n[1] }
            'L' { $p = New-Pt $n[0] $n[1]; $gp.AddLine($cur, $p); $cur = $p }
            'C' {
                $gp.AddBezier($cur, (New-Pt $n[0] $n[1]), (New-Pt $n[2] $n[3]), (New-Pt $n[4] $n[5]))
                $cur = New-Pt $n[4] $n[5]
            }
            'Z' { $gp.CloseFigure() }
        }
    }
    return $gp
}

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Black rounded-square background (macOS masks the square; we round it for Windows).
    $radius = [math]::Round($size * 0.22)
    $d = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $black = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
    $g.FillPath($black, $path)

    # White bolt.
    $bolt = Build-Bolt ([single]($size / 1024.0))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($white, $bolt)

    $black.Dispose(); $white.Dispose(); $bolt.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

$sizes = @(256, 64, 48, 32, 16)
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , ($ms.ToArray()); $ms.Dispose(); $bmp.Dispose()
}

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $bw.Write($png) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($OutPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
Write-Host "Wrote $OutPath ($([math]::Round((Get-Item $OutPath).Length / 1KB, 1)) KB)"
