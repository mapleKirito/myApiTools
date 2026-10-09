# Packaging script for myApiTools (Windows).
#
# Why this exists:
#   electron-builder normally extracts Electron into "win-unpacked.tmp" and then
#   renames it to "win-unpacked". A real-time AV scanner (e.g. Tencent PC Manager)
#   may hold handles on the freshly extracted .exe/.dll files at that moment, which
#   makes the rename fail with EPERM: operation not permitted.
#   To avoid that step entirely we pre-extract Electron ourselves and point
#   electronDist at it, so electron-builder takes the copyDir branch (no .tmp, no rename).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\dist.ps1
#   (or: npm run dist:win)
# Note: must run OUTSIDE the sandbox, because electron-builder writes to
#       AppData\Local\electron-builder\Cache.
#
# IMPORTANT: keep every string in this file ASCII. Windows PowerShell 5.1 reads a
# BOM-less UTF-8 script as ANSI/GBK, which corrupts non-ASCII literals and can even
# break parsing. ASCII bytes are identical under every code page.

# Switch to Node 22 explicitly (nvm use only affects newly opened shells).
$env:NODE_HOME = "C:\Users\maple\AppData\Roaming\nvm\v22.22.2"
$env:PATH      = "$env:NODE_HOME;$env:PATH"

# China mirrors, to avoid ECONNRESET while downloading Electron binaries.
$env:ELECTRON_MIRROR                  = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

# Build output outside the workspace.
$tmpOut = "C:\Users\maple\AppData\Local\Temp\myApiTools-dist"
Remove-Item -Recurse -Force $tmpOut -ErrorAction SilentlyContinue

# Project root (parent of this script's directory).
$root = Split-Path -Parent $PSScriptRoot

# Pre-extract Electron and hand it to electron-builder via electronDist.
$electronVersion = (Get-Content (Join-Path $root "node_modules\electron\package.json") -Raw | ConvertFrom-Json).version
$electronDist    = Join-Path $env:LOCALAPPDATA "electron\dist\electron-v$electronVersion-win32-x64"

if (-not (Test-Path (Join-Path $electronDist "electron.exe"))) {
    $zip = Get-ChildItem (Join-Path $env:LOCALAPPDATA "electron\Cache") -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $zip) { throw "Electron v$electronVersion zip not found in cache; run a normal build once to populate it." }
    Write-Host "-> pre-extracting Electron v$electronVersion to $electronDist" -ForegroundColor Cyan
    Remove-Item -Recurse -Force $electronDist -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $electronDist -Force | Out-Null
    tar -xf $zip.FullName -C $electronDist
    if ($LASTEXITCODE -ne 0) { throw "failed to extract $($zip.FullName)" }
}

Push-Location $root
try {
    Write-Host "-> Node $(node --version)" -ForegroundColor Cyan
    Write-Host "-> output dir: $tmpOut" -ForegroundColor Cyan
    Write-Host "-> building..." -ForegroundColor Cyan
    npx electron-builder --config electron-builder.yml --config.directories.output=$tmpOut --config.electronDist=$electronDist
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed, exit code: $LASTEXITCODE" }

    # Copy artifacts back into the project's dist/ directory.
    New-Item -ItemType Directory -Path dist -Force | Out-Null
    Copy-Item "$tmpOut\*.exe", "$tmpOut\*.blockmap" -Destination dist -Force

    Write-Host ""
    Write-Host "=== Done. Artifacts copied to dist/ ===" -ForegroundColor Green
    Get-ChildItem dist -Force | Where-Object { -not $_.PSIsContainer } |
        Format-Table Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime -AutoSize
}
finally {
    Pop-Location
}