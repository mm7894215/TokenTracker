const KEY_ENABLED = "tokentracker_cloud_sync_enabled";
const KEY_DEVICE = "tokentracker_cloud_device_session_v1";
const KEY_LAST_SYNC = "tokentracker_cloud_last_sync_ts";
let memoryDeviceSession: CloudDeviceSession | null = null;

export type CloudDeviceSession = {
  token: string;
  deviceId: string;
  issuedAt: string;
};

function clearLegacyStoredDeviceSession(): void {
  try {
    localStorage.removeItem(KEY_DEVICE);
  } catch {
    /* ignore */
  }
}

export function isLocalDashboardHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  // Mirror src/lib/local-api.js loopback handling (which includes IPv6) so the
  // dashboard ↔ local-server contract — cloud-sync mirror, account view — holds
  // on http://[::1] too. Browsers report IPv6 hostnames without brackets.
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** 默认关闭：需用户手动开启后才同步到云端 */
export function getCloudSyncEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY_ENABLED);
    if (v === null || v === "") return false;
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

export function setCloudSyncEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY_ENABLED, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
  // Mirror the toggle to the local CLI server (best-effort, localhost only) so
  // the auth-unaware native popover can gate its cross-device "account view" on
  // the same preference. The dashboard remains the source of truth; this is a
  // one-way push and never blocks the toggle.
  mirrorCloudSyncPrefToLocalServer(enabled);
  // Notify the SAME tab. AccountViewContext listens for this event (and the
  // cross-tab `storage` event) to recompute accountView. Without it, toggling
  // cloud sync on localhost would not switch the dashboard to the cross-device
  // cloud view until a manual reload — the multi-machine view stayed invisible
  // on the most common path. (Event name mirrors CLOUD_SYNC_CHANGE_EVENT in
  // AccountViewContext.jsx; dispatched here to avoid an import cycle.)
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("tt.cloudSyncChanged"));
    }
  } catch {
    /* ignore */
  }
}

async function mirrorCloudSyncPrefToLocalServer(enabled: boolean): Promise<void> {
  if (!isLocalDashboardHost()) return;
  try {
    const { getLocalApiAuthHeaders } = await import("./local-api-auth");
    const authHeaders = await getLocalApiAuthHeaders();
    await fetch("/functions/tokentracker-cloud-sync-pref", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
      cache: "no-store",
      body: JSON.stringify({ enabled }),
    });
  } catch {
    /* best-effort: popover falls back to local data if the mirror is stale */
  }
}

/**
 * Push the dashboard's current cloud-sync preference to the local CLI server
 * once on load, so the native popover's account view reflects the persisted
 * toggle even when the user never re-toggles it this session. No-op off
 * localhost. Best-effort.
 */
export function syncCloudSyncPrefToLocalServer(): void {
  void mirrorCloudSyncPrefToLocalServer(getCloudSyncEnabled());
}

export function getStoredDeviceSession(): CloudDeviceSession | null {
  clearLegacyStoredDeviceSession();
  return memoryDeviceSession;
}

export function setStoredDeviceSession(session: CloudDeviceSession): void {
  memoryDeviceSession = session;
  clearLegacyStoredDeviceSession();
}

export function clearCloudDeviceSession(): void {
  memoryDeviceSession = null;
  try {
    localStorage.removeItem(KEY_LAST_SYNC);
  } catch {
    /* ignore */
  }
  clearLegacyStoredDeviceSession();
}

export function getLastCloudSyncTs(): number {
  try {
    const n = Number(localStorage.getItem(KEY_LAST_SYNC));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function setLastCloudSyncTs(ts: number): void {
  try {
    localStorage.setItem(KEY_LAST_SYNC, String(ts));
  } catch {
    /* ignore */
  }
}
