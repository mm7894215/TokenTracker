import { isNativeEmbed, postNativeMessage } from "./native-bridge.js";

// Unified notification-permission state across delivery channels:
// - macOS app: UNUserNotificationCenter status pushed by NativeBridge via a
//   `native:notificationPermission` CustomEvent ("granted"|"denied"|"notDetermined").
// - Windows app: tray balloon tips need no permission — always "granted".
//   (WebView2 silently denies the Web Notification API, so reading it there
//   would report a false "denied" even though balloons work.)
// - Browser: the Web Notification API's own permission.
const NATIVE_EVENT = "native:notificationPermission";

let nativeStatus = null;

function isWindowsHost() {
  return typeof window !== "undefined" && Boolean(window.chrome?.webview);
}

export function getNotificationPermission() {
  if (isNativeEmbed()) return nativeStatus || "unknown";
  if (isWindowsHost()) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Subscribe to permission changes; fires immediately with the current value
 * and re-queries the macOS host so a fresh page reflects system settings.
 * Returns an unsubscribe function.
 */
export function watchNotificationPermission(onChange) {
  if (typeof window === "undefined") return () => {};
  const handler = (event) => {
    const status = event?.detail?.status;
    if (typeof status === "string") nativeStatus = status;
    onChange(getNotificationPermission());
  };
  window.addEventListener(NATIVE_EVENT, handler);
  onChange(getNotificationPermission());
  if (isNativeEmbed()) postNativeMessage({ type: "getNotificationStatus" });
  return () => window.removeEventListener(NATIVE_EVENT, handler);
}

/**
 * Ask for permission on the channel that will actually deliver alerts. Safe
 * to call repeatedly: hosts only show a dialog while status is undetermined.
 */
export async function ensureNotificationPermission() {
  if (isNativeEmbed()) {
    postNativeMessage({ type: "requestNotificationPermission" });
    return;
  }
  if (isWindowsHost()) return;
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission().catch(() => "denied");
  }
}
