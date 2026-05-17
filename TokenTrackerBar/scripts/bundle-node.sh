#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
# bundle-node.sh
# Downloads Node.js binary and bundles
# tokentracker source into EmbeddedServer/
#
# Usage:
#   ./bundle-node.sh              # universal (arm64 + x64)
#   ./bundle-node.sh --arch arm64 # Apple Silicon only
#   ./bundle-node.sh --arch x64   # Intel only
#   ./bundle-node.sh --clean      # wipe EmbeddedServer/
# ──────────────────────────────────────────────

NODE_VERSION="22.22.2"
TARGET_ARCH="universal"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EMBED_DIR="$SCRIPT_DIR/../EmbeddedServer"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      echo "🧹 Cleaning EmbeddedServer/..."
      rm -rf "$EMBED_DIR"
      echo "Done."
      exit 0
      ;;
    --arch)
      TARGET_ARCH="${2:-universal}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# ── Always start fresh ──
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"

TMPDIR_BUNDLE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUNDLE"' EXIT

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Download Node.js v${NODE_VERSION}
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
ARM64_TAR="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
X64_TAR="node-v${NODE_VERSION}-darwin-x64.tar.gz"

if [[ "$TARGET_ARCH" == "arm64" ]]; then
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (arm64 only)..."
  curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$ARM64_TAR" "$NODE_BASE_URL/$ARM64_TAR"
  tar -xzf "$TMPDIR_BUNDLE/$ARM64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-arm64/bin/node"
  cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-arm64/bin/node" "$EMBED_DIR/node"
elif [[ "$TARGET_ARCH" == "x64" ]]; then
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (x64 only)..."
  curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$X64_TAR" "$NODE_BASE_URL/$X64_TAR"
  tar -xzf "$TMPDIR_BUNDLE/$X64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-x64/bin/node"
  cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-x64/bin/node" "$EMBED_DIR/node"
else
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (arm64 + x64)..."
  curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$ARM64_TAR" "$NODE_BASE_URL/$ARM64_TAR"
  curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$X64_TAR"   "$NODE_BASE_URL/$X64_TAR"
  tar -xzf "$TMPDIR_BUNDLE/$ARM64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-arm64/bin/node"
  tar -xzf "$TMPDIR_BUNDLE/$X64_TAR"   -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-x64/bin/node"
  echo "🔗 Creating universal binary with lipo..."
  lipo -create \
    "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-arm64/bin/node" \
    "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-x64/bin/node" \
    -output "$EMBED_DIR/node"
fi

chmod +x "$EMBED_DIR/node"
echo "✅ Node.js binary ready ($TARGET_ARCH)"
file "$EMBED_DIR/node"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. Bundle tokentracker source
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "📂 Copying tokentracker source..."

TT_DIR="$EMBED_DIR/tokentracker"
mkdir -p "$TT_DIR/bin"

cp "$REPO_ROOT/bin/tracker.js" "$TT_DIR/bin/"
cp -R "$REPO_ROOT/src" "$TT_DIR/src"
cp "$REPO_ROOT/package.json" "$TT_DIR/"

# Dashboard build artifacts
if [[ -d "$REPO_ROOT/dashboard/dist" ]]; then
  mkdir -p "$TT_DIR/dashboard"
  cp -R "$REPO_ROOT/dashboard/dist" "$TT_DIR/dashboard/dist"
else
  echo "⚠️  dashboard/dist/ not found — run 'npm run dashboard:build' first"
  echo "   Continuing without dashboard assets..."
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Install production dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "📥 Installing production dependencies..."
(cd "$TT_DIR" && npm install --omit=dev --no-optional --ignore-scripts 2>&1 | tail -1)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Clean node_modules bloat
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "🗑️  Cleaning node_modules bloat..."

find "$TT_DIR/node_modules" -type f \( \
  -name "*.md" -o \
  -name "*.txt" -o \
  -name "*.map" -o \
  -name "*.ts" -o \
  -name "*.d.ts" -o \
  -iname "LICENSE*" -o \
  -iname "LICENCE*" -o \
  -iname "CHANGELOG*" -o \
  -iname "CHANGES*" -o \
  -iname "HISTORY*" -o \
  -name ".npmignore" -o \
  -name ".eslintrc*" -o \
  -name ".prettierrc*" -o \
  -name "tsconfig.json" -o \
  -name ".editorconfig" \
\) -delete 2>/dev/null || true

find "$TT_DIR/node_modules" -type d \( \
  -name "test" -o \
  -name "tests" -o \
  -name "__tests__" -o \
  -name "examples" -o \
  -name "example" -o \
  -name "docs" -o \
  -name ".github" \
\) -exec rm -rf {} + 2>/dev/null || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. Size report
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "═══════════════════════════════════════"
echo "  EmbeddedServer Size Report ($TARGET_ARCH)"
echo "═══════════════════════════════════════"

NODE_SIZE=$(du -sh "$EMBED_DIR/node" | cut -f1)
TT_SRC_SIZE=$(du -sh "$TT_DIR/src" "$TT_DIR/bin" | tail -1 | cut -f1)
NM_SIZE=$(du -sh "$TT_DIR/node_modules" 2>/dev/null | cut -f1 || echo "0")
DASH_SIZE=$(du -sh "$TT_DIR/dashboard/dist" 2>/dev/null | cut -f1 || echo "N/A")
TOTAL_SIZE=$(du -sh "$EMBED_DIR" | cut -f1)

printf "  %-25s %s\n" "Node.js binary:" "$NODE_SIZE"
printf "  %-25s %s\n" "Source (src/ + bin/):" "$TT_SRC_SIZE"
printf "  %-25s %s\n" "node_modules:" "$NM_SIZE"
printf "  %-25s %s\n" "Dashboard dist:" "$DASH_SIZE"
echo "───────────────────────────────────────"
printf "  %-25s %s\n" "TOTAL:" "$TOTAL_SIZE"
echo "═══════════════════════════════════════"
echo ""
echo "✅ Bundle complete: $EMBED_DIR"
