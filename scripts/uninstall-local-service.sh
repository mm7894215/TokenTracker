#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
DASHBOARD_LABEL="com.pitimon.tokentracker.dashboard"
LOCAL_SYNC_LABEL="com.pitimon.tokentracker.local-sync"
DASHBOARD_PLIST="$AGENTS_DIR/$DASHBOARD_LABEL.plist"
LOCAL_SYNC_PLIST="$AGENTS_DIR/$LOCAL_SYNC_LABEL.plist"
LOCAL_SYNC_WRAPPER="${TOKENTRACKER_HOME:-$HOME/.tokentracker}/bin/tokentracker-local-sync-service.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "TokenTracker local service uninstaller currently supports macOS launchd only." >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)" "$DASHBOARD_PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$LOCAL_SYNC_PLIST" >/dev/null 2>&1 || true

rm -f "$DASHBOARD_PLIST" "$LOCAL_SYNC_PLIST" "$LOCAL_SYNC_WRAPPER"

echo "Uninstalled TokenTracker local services."
