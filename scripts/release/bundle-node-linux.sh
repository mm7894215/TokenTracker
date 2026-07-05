#!/usr/bin/env bash
set -euo pipefail

# Builds a self-contained Linux x64 bundle:
#   build/linux-x64/
#     tokentracker
#     EmbeddedServer/node
#     EmbeddedServer/tokentracker/{bin,src,node_modules,dashboard/dist}

EXPECTED_NODE_VERSION="22.22.2"
NODE_VERSION="${NODE_VERSION:-$EXPECTED_NODE_VERSION}"
TARGET_ARCH="${TARGET_ARCH:-x64}"

if [[ "$NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Refusing to bundle Node.js v${NODE_VERSION}; expected pinned v${EXPECTED_NODE_VERSION}." >&2
  echo "Update EXPECTED_NODE_VERSION after validating npm test against the new Node runtime." >&2
  exit 1
fi

if [[ "$TARGET_ARCH" != "x64" ]]; then
  echo "Unsupported TARGET_ARCH: ${TARGET_ARCH}. This workflow currently ships linux-x64 only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_ROOT="$REPO_ROOT/build/linux-x64"
EMBED_DIR="$BUILD_ROOT/EmbeddedServer"
TT_DIR="$EMBED_DIR/tokentracker"
TMPDIR_BUNDLE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUNDLE"' EXIT

rm -rf "$BUILD_ROOT"
mkdir -p "$TT_DIR/bin"

NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_TAR="node-v${NODE_VERSION}-linux-x64.tar.xz"

echo "Downloading Node.js v${NODE_VERSION} (${TARGET_ARCH})..."
curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$NODE_TAR" "$NODE_BASE_URL/$NODE_TAR"
tar -xJf "$TMPDIR_BUNDLE/$NODE_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-linux-x64/bin/node"
cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-linux-x64/bin/node" "$EMBED_DIR/node"
chmod +x "$EMBED_DIR/node"

BUNDLED_NODE_VERSION="$("$EMBED_DIR/node" -p 'process.versions.node' 2>/dev/null || echo unknown)"
if [[ "$BUNDLED_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Bundled Node drifted: expected v${EXPECTED_NODE_VERSION}, got v${BUNDLED_NODE_VERSION}" >&2
  exit 1
fi

cp "$REPO_ROOT/bin/tracker.js" "$TT_DIR/bin/"
cp -R "$REPO_ROOT/src" "$TT_DIR/src"
cp "$REPO_ROOT/package.json" "$TT_DIR/"

if [[ ! -d "$REPO_ROOT/dashboard/dist" ]]; then
  echo "dashboard/dist not found. Run 'npm run dashboard:build' first." >&2
  exit 1
fi

mkdir -p "$TT_DIR/dashboard"
cp -R "$REPO_ROOT/dashboard/dist" "$TT_DIR/dashboard/dist"

(
  cd "$TT_DIR"
  npm install --omit=dev --no-optional --ignore-scripts
)

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

cat > "$BUILD_ROOT/tokentracker" <<'EOF'
#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/EmbeddedServer/node" "$SCRIPT_DIR/EmbeddedServer/tokentracker/bin/tracker.js" "$@"
EOF
chmod +x "$BUILD_ROOT/tokentracker"

echo "Linux bundle complete: $BUILD_ROOT"
