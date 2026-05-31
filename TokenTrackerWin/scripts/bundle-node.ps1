# ──────────────────────────────────────────────
# bundle-node.ps1  (Windows counterpart of TokenTrackerBar/scripts/bundle-node.sh)
#
# Downloads the pinned Node.js win-x64 binary and bundles the tokentracker CLI
# source + built dashboard into EmbeddedServer/, so the .exe is self-contained.
#
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-node.ps1
#   ... -Clean       # wipe EmbeddedServer\ and exit
#
# Build the dashboard first:  npm run dashboard:build   (from the repo root)
# ──────────────────────────────────────────────
param([switch]$Clean)

$ErrorActionPreference = 'Stop'

# Keep this pinned version in sync with TokenTrackerBar/scripts/bundle-node.sh.
$ExpectedNodeVersion = '22.22.2'
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { $ExpectedNodeVersion }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WinProjDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $WinProjDir
$EmbedDir  = Join-Path $WinProjDir 'EmbeddedServer'

if ($Clean) {
    if (Test-Path $EmbedDir) { Remove-Item -Recurse -Force $EmbedDir }
    Write-Host 'Cleaned EmbeddedServer\'
    exit 0
}

if ($NodeVersion -ne $ExpectedNodeVersion) {
    Write-Error "Refusing to bundle Node v$NodeVersion; expected pinned v$ExpectedNodeVersion. Run npm test against the new Node first."
}

if (Test-Path $EmbedDir) { Remove-Item -Recurse -Force $EmbedDir }
New-Item -ItemType Directory -Force -Path $EmbedDir | Out-Null

# 1. Download Node.js win-x64
$zipName = "node-v$NodeVersion-win-x64.zip"
$url = "https://nodejs.org/dist/v$NodeVersion/$zipName"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ttnode-$NodeVersion"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $zipName

Write-Host "Downloading Node.js v$NodeVersion (win-x64)..."
Invoke-WebRequest -Uri $url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
$nodeExe = Join-Path $tmp "node-v$NodeVersion-win-x64\node.exe"
if (-not (Test-Path $nodeExe)) { Write-Error "node.exe not found in archive" }
Copy-Item $nodeExe (Join-Path $EmbedDir 'node.exe')

$bundledVersion = (& (Join-Path $EmbedDir 'node.exe') -p 'process.versions.node').Trim()
if ($bundledVersion -ne $ExpectedNodeVersion) {
    Write-Error "Bundled Node drifted: expected v$ExpectedNodeVersion, got v$bundledVersion"
}
Write-Host "Node.js ready - v$bundledVersion"

# 2. Bundle tokentracker source
$ttDir = Join-Path $EmbedDir 'tokentracker'
New-Item -ItemType Directory -Force -Path (Join-Path $ttDir 'bin') | Out-Null
Copy-Item (Join-Path $RepoRoot 'bin\tracker.js') (Join-Path $ttDir 'bin\')
Copy-Item (Join-Path $RepoRoot 'src') (Join-Path $ttDir 'src') -Recurse
Copy-Item (Join-Path $RepoRoot 'package.json') $ttDir

$dashDist = Join-Path $RepoRoot 'dashboard\dist'
if (Test-Path $dashDist) {
    New-Item -ItemType Directory -Force -Path (Join-Path $ttDir 'dashboard') | Out-Null
    Copy-Item $dashDist (Join-Path $ttDir 'dashboard\dist') -Recurse
} else {
    Write-Warning "dashboard\dist not found - run 'npm run dashboard:build' first. Continuing without dashboard assets."
}

# 3. Install production dependencies
Write-Host 'Installing production dependencies...'
Push-Location $ttDir
try {
    & npm install --omit=dev --no-optional --ignore-scripts | Out-Null
} finally {
    Pop-Location
}

# 4. Trim node_modules bloat
$nm = Join-Path $ttDir 'node_modules'
if (Test-Path $nm) {
    Get-ChildItem $nm -Recurse -File -Include `
        '*.md','*.txt','*.map','*.ts','*.d.ts','LICENSE*','LICENCE*', `
        'CHANGELOG*','CHANGES*','HISTORY*','.npmignore','.eslintrc*', `
        '.prettierrc*','tsconfig.json','.editorconfig' `
        -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem $nm -Recurse -Directory -Include `
        'test','tests','__tests__','examples','example','docs','.github' `
        -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$total = [math]::Round((Get-ChildItem $EmbedDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Bundle complete: $EmbedDir ($total MB)"
