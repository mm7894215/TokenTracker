# ──────────────────────────────────────────────
# make-tray-mascot.ps1
# Builds the Clawd tray icons from the macOS menu-bar mascot
# (TokenTrackerBar .../MenuBarIcon.imageset/menubar_36.png), recoloured for the
# Windows notification area:
#   tray-mascot-onDark.ico   white glyph  — for the default dark taskbar
#   tray-mascot-onLight.ico  dark glyph   — for a light taskbar
# The app picks one at runtime from the taskbar theme (SystemUsesLightTheme).
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-tray-mascot.ps1
# ──────────────────────────────────────────────
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WinProjDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $WinProjDir
$AssetsDir = Join-Path $WinProjDir 'assets'
$Src = Join-Path $RepoRoot 'TokenTrackerBar\TokenTrackerBar\Assets.xcassets\MenuBarIcon.imageset\menubar_36.png'
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

if (-not (Test-Path $Src)) { Write-Error "Source mascot not found: $Src" }

$source = [System.Drawing.Bitmap]::FromFile($Src)

function New-Recolored([System.Drawing.Bitmap]$src, [int]$r, [int]$g, [int]$b) {
    $bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            $a = $src.GetPixel($x, $y).A
            $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, $r, $g, $b))
        }
    }
    return $bmp
}

function Save-Ico([System.Drawing.Bitmap]$glyph, [string]$outPath) {
    $sizes = @(32, 24, 20, 16)
    $pngs = @()
    foreach ($s in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor  # keep pixel-art crisp
        $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $gfx.Clear([System.Drawing.Color]::Transparent)
        $gfx.DrawImage($glyph, 0, 0, $s, $s)
        $gfx.Dispose()
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
        $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32)
        $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
        $offset += $pngs[$i].Length
    }
    foreach ($png in $pngs) { $bw.Write($png) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($outPath, $out.ToArray())
    $bw.Dispose(); $out.Dispose()
    Write-Host "Wrote $outPath"
}

$white = New-Recolored $source 245 245 245
Save-Ico $white (Join-Path $AssetsDir 'tray-mascot-onDark.ico')
$white.Dispose()

$dark = New-Recolored $source 32 32 32
Save-Ico $dark (Join-Path $AssetsDir 'tray-mascot-onLight.ico')
$dark.Dispose()

$source.Dispose()
