import { useCallback, useEffect, useState } from "react";
import { isNewerVersion } from "../lib/app-update.js";
import {
  isNativeApp,
  isNativeEmbed,
  onNativeSettings,
  postNativeMessage,
  requestNativeSettings,
} from "../lib/native-bridge.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/mm7894215/TokenTracker/releases/latest";
const RELEASE_PAGE_PREFIX = "https://github.com/mm7894215/TokenTracker/releases/";
const CURRENT_VERSION = import.meta.env.VITE_APP_VERSION || "";

export function useAppUpdate() {
  const nativeApp = isNativeApp();
  const [release, setRelease] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nativeApp || !CURRENT_VERSION) return undefined;
    const controller = new AbortController();

    fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Update check failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        const latestVersion = typeof data?.tag_name === "string" ? data.tag_name : "";
        if (!isNewerVersion(CURRENT_VERSION, latestVersion)) return;
        const htmlUrl = typeof data?.html_url === "string" && data.html_url.startsWith(RELEASE_PAGE_PREFIX)
          ? data.html_url
          : "";
        setRelease({ latestVersion, htmlUrl });
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.warn("[tokentracker] update availability check failed:", error);
        }
      });

    return () => controller.abort();
  }, [nativeApp]);

  // macOS already publishes updater progress through native settings. Reuse it
  // so the CTA cannot trigger a second check while an automatic update is busy.
  useEffect(() => {
    if (!nativeApp || !isNativeEmbed()) return undefined;
    const unsubscribe = onNativeSettings((settings) => setBusy(Boolean(settings?.updateBusy)));
    requestNativeSettings();
    return unsubscribe;
  }, [nativeApp]);

  const requestUpdate = useCallback(() => {
    if (!release) return false;
    const sent = postNativeMessage({ type: "action", name: "checkForUpdates" });
    if (!sent && release.htmlUrl && typeof window !== "undefined") {
      window.open(release.htmlUrl, "_blank", "noopener,noreferrer");
    }
    return sent;
  }, [release]);

  return {
    available: Boolean(release),
    latestVersion: release?.latestVersion || "",
    busy,
    requestUpdate,
  };
}
