import { useCallback, useEffect, useState } from "react";
import {
  isBridgeAvailable,
  isNativeApp,
  nativeAction,
  onNativeSettings,
  requestNativeSettings,
  setNativeSetting,
} from "../lib/native-bridge";

/**
 * Read/write menu-bar app preferences via the WKWebView NativeBridge.
 *
 * Returns:
 *   { available, settings, setSetting, runAction, refresh }
 *
 * `available` is true only when running inside the native macOS app
 * AND the bridge handler is wired up. SettingsPage uses it to gate the
 * "Menu Bar App" section so it stays hidden in browser/cloud mode.
 */
export function useNativeSettings() {
  const [settings, setSettings] = useState(null);
  const available = isNativeApp() && isBridgeAvailable();

  useEffect(() => {
    if (!available) return undefined;
    const unsubscribe = onNativeSettings((detail) => setSettings(detail));
    requestNativeSettings();
    return unsubscribe;
  }, [available]);

  const setSetting = useCallback(
    (key, value) => {
      if (!available) return;
      // Optimistic update — bridge will push the canonical value back
      setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
      setNativeSetting(key, value);
    },
    [available],
  );

  const runAction = useCallback(
    (name) => {
      if (!available) return;
      nativeAction(name);
    },
    [available],
  );

  const refresh = useCallback(() => {
    if (!available) return;
    requestNativeSettings();
  }, [available]);

  return { available, settings, setSetting, runAction, refresh };
}
