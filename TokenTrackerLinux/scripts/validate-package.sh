#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <tokentracker-linux.pkg.tar.zst>" >&2
  exit 2
fi

PACKAGE_PATH="$(realpath "$1")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXPECTED_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
EXPECTED_NODE_VERSION="22.22.2"

if [[ ! -f "$PACKAGE_PATH" ]]; then
  echo "Package not found: $PACKAGE_PATH" >&2
  exit 1
fi

PACKAGE_INFO="$(pacman -Qip "$PACKAGE_PATH")"
grep -Eq '^Name[[:space:]]*:[[:space:]]*tokentracker-linux$' <<<"$PACKAGE_INFO"
grep -Eq "^Version[[:space:]]*:[[:space:]]*${EXPECTED_VERSION}-[0-9]+$" <<<"$PACKAGE_INFO"
grep -Eq '^Architecture[[:space:]]*:[[:space:]]*x86_64$' <<<"$PACKAGE_INFO"

TMPDIR_PACKAGE="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_PACKAGE"
}
trap cleanup EXIT

bsdtar -xf "$PACKAGE_PATH" -C "$TMPDIR_PACKAGE"

required_paths=(
  usr/bin/tokentracker-linux
  usr/lib/tokentracker-linux/node
  usr/lib/tokentracker-linux/tokentracker/bin/tracker.js
  usr/lib/tokentracker-linux/tokentracker/dashboard/dist/index.html
  usr/share/applications/tokentracker-linux.desktop
  usr/share/icons/hicolor/512x512/apps/tokentracker-linux.png
  usr/share/licenses/tokentracker-linux/LICENSE
)
for required in "${required_paths[@]}"; do
  [[ -e "$TMPDIR_PACKAGE/$required" ]] || {
    echo "Package is missing $required" >&2
    exit 1
  }
done

[[ -x "$TMPDIR_PACKAGE/usr/bin/tokentracker-linux" ]]
[[ -x "$TMPDIR_PACKAGE/usr/lib/tokentracker-linux/node" ]]
file "$TMPDIR_PACKAGE/usr/bin/tokentracker-linux" | grep -Eq 'ELF 64-bit.*x86-64'
file "$TMPDIR_PACKAGE/usr/share/icons/hicolor/512x512/apps/tokentracker-linux.png" | grep -Fq 'PNG image data'

desktop_file="$TMPDIR_PACKAGE/usr/share/applications/tokentracker-linux.desktop"
desktop-file-validate "$desktop_file"
grep -Fxq 'Exec=tokentracker-linux %u' "$desktop_file"
grep -Fxq 'Icon=tokentracker-linux' "$desktop_file"
grep -Fxq 'MimeType=x-scheme-handler/tokentracker;' "$desktop_file"

bundled_node="$TMPDIR_PACKAGE/usr/lib/tokentracker-linux/node"
bundled_tracker="$TMPDIR_PACKAGE/usr/lib/tokentracker-linux/tokentracker/bin/tracker.js"
[[ "$($bundled_node -p 'process.versions.node')" == "$EXPECTED_NODE_VERSION" ]]

PORT="$($bundled_node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
RUNTIME_HOME="$TMPDIR_PACKAGE/runtime-home"
mkdir -p "$RUNTIME_HOME/config" "$RUNTIME_HOME/data" "$RUNTIME_HOME/state"
HOME="$RUNTIME_HOME" \
XDG_CONFIG_HOME="$RUNTIME_HOME/config" \
XDG_DATA_HOME="$RUNTIME_HOME/data" \
XDG_STATE_HOME="$RUNTIME_HOME/state" \
  "$bundled_node" "$bundled_tracker" serve \
    --port "$PORT" --no-open --no-sync \
    >"$TMPDIR_PACKAGE/server.out" 2>"$TMPDIR_PACKAGE/server.err" &
SERVER_PID=$!

for _ in {1..100}; do
  if curl -fsS "http://127.0.0.1:${PORT}/functions/tokentracker-user-status" >/dev/null; then
    printf 'Validated TokenTracker Linux package %s\n' "$PACKAGE_PATH"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

cat "$TMPDIR_PACKAGE/server.err" >&2 || true
echo "Bundled TokenTracker server did not become ready" >&2
exit 1
