/**
 * Bridge helpers for talking to the macOS TokenTrackerBar host via WKWebView's
 * `window.webkit.messageHandlers.nativeBridge`. The native side dispatches a
 * `native:settings` CustomEvent on `window` whenever state changes.
 *
 * Safe no-ops in browser/cloud mode.
 */

const NATIVE_APP_KEY = "tokentracker_native_app";

export function isNativeApp() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("app") === "1") {
      try { window.localStorage.setItem(NATIVE_APP_KEY, "1"); } catch { /* ignore */ }
      return true;
    }
    return window.localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch {
    return false;
  }
}

function getHandler() {
  if (typeof window === "undefined") return null;
  return window.webkit?.messageHandlers?.nativeBridge ?? null;
}

export function isBridgeAvailable() {
  return Boolean(getHandler());
}

function post(message) {
  const handler = getHandler();
  if (!handler) return false;
  try {
    handler.postMessage(message);
    return true;
  } catch (err) {
    console.warn("[tokentracker] nativeBridge post failed:", err);
    return false;
  }
}

export function requestNativeSettings() {
  return post({ type: "getSettings" });
}

export function setNativeSetting(key, value) {
  return post({ type: "setSetting", key, value });
}

export function nativeAction(name) {
  return post({ type: "action", name });
}

/**
 * Subscribe to native settings updates. Returns an unsubscribe function.
 * The handler is invoked with the settings object (`detail` of the CustomEvent).
 */
export function onNativeSettings(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => {
    if (event && event.detail && typeof event.detail === "object") {
      handler(event.detail);
    }
  };
  window.addEventListener("native:settings", listener);
  return () => window.removeEventListener("native:settings", listener);
}
