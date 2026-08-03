#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# create-dmg.sh — Create a professional DMG installer for TokenTracker
# Usage: ./create-dmg.sh [path/to/TokenTracker.app]
# Set CI=true to skip Finder/AppleScript customization (headless mode)
# =============================================================================

APP_NAME="TokenTracker"
VOLUME_NAME="TokenTracker"
# Keep the historical filename: the website and READMEs link to the stable
# releases/latest/download/TokenTrackerBar.dmg URL.
DMG_FILENAME="TokenTrackerBar.dmg"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${PROJECT_DIR}/build"
BG_IMAGE="${SCRIPT_DIR}/dmg-background.png"

# Window dimensions (non-retina logical points)
WIN_W=660
WIN_H=400
ICON_SIZE=128

# Icon positions — must match generate_dmg_bg.swift
APP_X=170
APP_Y=180
APPS_X=490
APPS_Y=180

# --- Resolve .app path ---
if [[ -n "${1:-}" ]]; then
    APP_PATH="$1"
else
    # Find latest build from DerivedData
    DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
    APP_PATH=$(find "$DERIVED" -maxdepth 4 -name "${APP_NAME}.app" -path "*/Build/Products/*" \
        -not -path "*/Index.noindex/*" 2>/dev/null | head -1 || true)

    if [[ -z "$APP_PATH" ]]; then
        # Try our local build directory
        APP_PATH="${BUILD_DIR}/${APP_NAME}.app"
    fi
fi

if [[ ! -d "$APP_PATH" ]]; then
    echo "Error: ${APP_NAME}.app not found at: $APP_PATH"
    echo "Usage: $0 [path/to/${APP_NAME}.app]"
    exit 1
fi

echo "==> App source: $APP_PATH"

# --- Verify background image ---
if [[ ! -f "$BG_IMAGE" ]]; then
    echo "Warning: Background image not found at $BG_IMAGE"
    echo "  Run: swift $SCRIPT_DIR/generate_dmg_bg.swift"
    echo "  Continuing without background..."
    HAS_BG=false
else
    HAS_BG=true
    echo "==> Background: $BG_IMAGE"
fi

# --- Prepare output directory ---
mkdir -p "$BUILD_DIR"

# --- Clean up previous artifacts ---
TEMP_DMG="${BUILD_DIR}/${APP_NAME}-temp.dmg"
FINAL_DMG="${BUILD_DIR}/${DMG_FILENAME}"
rm -f "$TEMP_DMG" "$FINAL_DMG"

# --- Create staging directory ---
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging in $STAGING"

# Copy app
cp -a "$APP_PATH" "$STAGING/${APP_NAME}.app"

# Create Applications symlink
ln -s /Applications "$STAGING/Applications"

# Copy background into a hidden directory (so it's inside the DMG)
if $HAS_BG; then
    mkdir -p "$STAGING/.background"
    cp "$BG_IMAGE" "$STAGING/.background/background.png"
fi

# --- Calculate DMG size ---
APP_SIZE_KB=$(du -sk "$STAGING/${APP_NAME}.app" | cut -f1)
DMG_SIZE_KB=$(( APP_SIZE_KB + 20480 ))  # app + 20MB headroom
echo "==> App size: ${APP_SIZE_KB}KB, DMG allocation: ${DMG_SIZE_KB}KB"

# --- Create temporary read-write DMG ---
echo "==> Creating temporary DMG..."
hdiutil create \
    -srcfolder "$STAGING" \
    -volname "$VOLUME_NAME" \
    -fs HFS+ \
    -fsargs "-c c=64,a=16,e=16" \
    -format UDRW \
    -size "${DMG_SIZE_KB}k" \
    "$TEMP_DMG"

# --- CI mode: bypass our hdiutil pipeline entirely and use the Homebrew
#     `create-dmg` tool, which writes the .DS_Store directly (no Finder/AppleScript
#     needed). This is the only way to get the background + icon layout on a
#     headless macOS runner. ---
if [[ "${CI:-}" == "true" ]]; then
    if ! command -v create-dmg >/dev/null 2>&1; then
        echo "Error: CI mode requires the Homebrew 'create-dmg' tool."
        echo "  brew install create-dmg"
        exit 1
    fi

    echo "==> CI mode: using Homebrew create-dmg for headless DMG layout"

    BG_ARGS=()
    if $HAS_BG; then
        BG_ARGS=(--background "$BG_IMAGE")
    fi

    # The Homebrew create-dmg tool stages the .app, builds the DMG, applies
    # background + icon positions, and finalizes — all without Finder.
    # Note: it expects to create the OUTPUT file, so remove any leftover.
    rm -f "$FINAL_DMG"
    create-dmg \
        --volname "$VOLUME_NAME" \
        --format ULMO \
        --window-pos 200 120 \
        --window-size "$WIN_W" "$WIN_H" \
        --icon-size "$ICON_SIZE" \
        --icon "${APP_NAME}.app" "$APP_X" "$APP_Y" \
        --app-drop-link "$APPS_X" "$APPS_Y" \
        "${BG_ARGS[@]}" \
        "$FINAL_DMG" \
        "$APP_PATH"

    FINAL_SIZE=$(du -sh "$FINAL_DMG" | cut -f1)
    echo ""
    echo "================================================"
    echo "  DMG created successfully (CI path)!"
    echo "  Output: $FINAL_DMG"
    echo "  Size:   $FINAL_SIZE"
    echo "================================================"
    rm -f "$TEMP_DMG"
    exit 0
fi

# --- Mount and customize ---
echo "==> Mounting and customizing..."
# Detach any existing volume with same name
hdiutil detach "/Volumes/$VOLUME_NAME" 2>/dev/null || true
sleep 1

MOUNT_OUTPUT=$(hdiutil attach -readwrite -noverify "$TEMP_DMG")
MOUNT_DIR=$(echo "$MOUNT_OUTPUT" | grep "/Volumes/" | sed 's/.*\/Volumes/\/Volumes/')
MOUNT_DEV=$(echo "$MOUNT_OUTPUT" | head -1 | awk '{print $1}')

echo "==> Mounted at: $MOUNT_DIR"

# Apply Finder customizations via AppleScript (local interactive path)
if true; then
    if $HAS_BG; then
        BG_CLAUSE='set background picture of viewOptions to POSIX file "'$MOUNT_DIR'/.background/background.png"'
    else
        BG_CLAUSE=""
    fi

    # Extract the actual volume name from mount path
    ACTUAL_VOL_NAME=$(basename "$MOUNT_DIR")

    echo "==> Applying Finder settings..."
    osascript <<APPLESCRIPT
tell application "Finder"
    tell disk "$ACTUAL_VOL_NAME"
        open
        delay 2
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {100, 100, $((100 + WIN_W)), $((100 + WIN_H))}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to $ICON_SIZE
        ${BG_CLAUSE}
        set position of item "${APP_NAME}.app" of container window to {${APP_X}, ${APP_Y}}
        set position of item "Applications" of container window to {${APPS_X}, ${APPS_Y}}
        close
        open
        delay 1
        close
    end tell
end tell
APPLESCRIPT

    sync

    # --- Unmount ---
    echo "==> Unmounting..."
    hdiutil detach "$MOUNT_DEV" -quiet 2>/dev/null || hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
    sleep 1
fi

# --- Convert to compressed read-only ---
# ULMO (LZMA) shaves ~25% off UDZO for the Node-binary-heavy payload; it
# requires macOS 10.15+ to mount, well below the app's 12.0 deployment target.
echo "==> Compressing to final DMG..."
hdiutil convert "$TEMP_DMG" \
    -format ULMO \
    -o "$FINAL_DMG"

rm -f "$TEMP_DMG"

# --- Done ---
FINAL_SIZE=$(du -sh "$FINAL_DMG" | cut -f1)
echo ""
echo "================================================"
echo "  DMG created successfully!"
echo "  Output: $FINAL_DMG"
echo "  Size:   $FINAL_SIZE"
echo "================================================"
