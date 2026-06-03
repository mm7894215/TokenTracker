#!/usr/bin/env bash
set -euo pipefail

PORT="${TOKENTRACKER_DASHBOARD_PORT:-7680}"
PACKAGE_NAME="${TOKENTRACKER_NPM_PACKAGE:-@ipv9/tokentracker-cli}"
TRACKER_HOME="${TOKENTRACKER_HOME:-$HOME/.tokentracker}"
SERVICE_PATH="${TOKENTRACKER_SERVICE_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
LOG_DIR="$TRACKER_HOME/tracker/logs"
BIN_DIR="$TRACKER_HOME/bin"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DASHBOARD_LABEL="com.pitimon.tokentracker.dashboard"
LOCAL_SYNC_LABEL="com.pitimon.tokentracker.local-sync"
DASHBOARD_PLIST="$AGENTS_DIR/$DASHBOARD_LABEL.plist"
LOCAL_SYNC_PLIST="$AGENTS_DIR/$LOCAL_SYNC_LABEL.plist"
LOCAL_SYNC_WRAPPER="$BIN_DIR/tokentracker-local-sync-service.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "TokenTracker local service installer currently supports macOS launchd only." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$BIN_DIR" "$AGENTS_DIR"

cat > "$LOCAL_SYNC_WRAPPER" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${TOKENTRACKER_CONFIG_PATH:-$HOME/.tokentracker/tracker/config.json}"
PACKAGE_NAME="${TOKENTRACKER_NPM_PACKAGE:-@ipv9/tokentracker-cli}"
export PATH="${TOKENTRACKER_SERVICE_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

if [[ -n "${TOKENTRACKER_DEVICE_TOKEN:-}" ]]; then
  echo "TokenTracker local-sync skipped: TOKENTRACKER_DEVICE_TOKEN is configured."
  exit 0
fi

if [[ -f "$CONFIG_PATH" ]]; then
  HAS_DEVICE_TOKEN="$(node -e '
const fs = require("node:fs");
const p = process.argv[1];
try {
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  process.stdout.write(typeof cfg.deviceToken === "string" && cfg.deviceToken.trim() ? "1" : "0");
} catch {
  process.stdout.write("0");
}
' "$CONFIG_PATH")"
  if [[ "$HAS_DEVICE_TOKEN" == "1" ]]; then
    echo "TokenTracker local-sync skipped: deviceToken is configured."
    exit 0
  fi
fi

exec npx --yes "$PACKAGE_NAME" sync --auto
WRAPPER
chmod 0755 "$LOCAL_SYNC_WRAPPER"

launchctl bootout "gui/$(id -u)" "$DASHBOARD_PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$LOCAL_SYNC_PLIST" >/dev/null 2>&1 || true

cat > "$DASHBOARD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$DASHBOARD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npx</string>
    <string>--yes</string>
    <string>$PACKAGE_NAME</string>
    <string>serve</string>
    <string>--sync</string>
    <string>--no-open</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$SERVICE_PATH</string>
    <key>TOKENTRACKER_NPM_PACKAGE</key>
    <string>$PACKAGE_NAME</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dashboard.err.log</string>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
</dict>
</plist>
PLIST

cat > "$LOCAL_SYNC_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LOCAL_SYNC_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LOCAL_SYNC_WRAPPER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$SERVICE_PATH</string>
    <key>TOKENTRACKER_NPM_PACKAGE</key>
    <string>$PACKAGE_NAME</string>
    <key>TOKENTRACKER_SERVICE_PATH</key>
    <string>$SERVICE_PATH</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/local-sync.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/local-sync.err.log</string>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$DASHBOARD_PLIST"
launchctl bootstrap "gui/$(id -u)" "$LOCAL_SYNC_PLIST"

echo "Installed TokenTracker local services:"
echo "  $DASHBOARD_LABEL -> http://127.0.0.1:$PORT/dashboard (syncs once before serving)"
echo "  $LOCAL_SYNC_LABEL -> local sync every 5 minutes, skips when deviceToken is configured"
echo "Logs: $LOG_DIR"
