import { useCallback, useEffect, useState } from "react";
import {
  ensureNotificationPermission,
  watchNotificationPermission,
} from "../lib/notification-permission.js";

export const LIMIT_ALERTS_PREF_KEY = "tt.limitAlerts.enabled";

function readEnabled() {
  try { return window.localStorage.getItem(LIMIT_ALERTS_PREF_KEY) === "1"; } catch { return false; }
}

export function useLimitAlertPrefs() {
  const [enabled, setEnabledState] = useState(readEnabled);
  const [permission, setPermission] = useState("unknown");

  useEffect(() => watchNotificationPermission(setPermission), []);

  const setEnabled = useCallback(async (next: boolean) => {
    const value = Boolean(next);
    // Tie the permission dialog to the user's gesture: asking the moment the
    // bell is switched on beats a surprise system prompt hours later when the
    // first alert fires.
    if (value) await ensureNotificationPermission();
    try { window.localStorage.setItem(LIMIT_ALERTS_PREF_KEY, value ? "1" : "0"); } catch { /* restricted webview */ }
    setEnabledState(value);
  }, []);

  return { enabled, setEnabled, permissionBlocked: permission === "denied" };
}
