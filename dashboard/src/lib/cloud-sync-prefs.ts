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
  return h === "localhost" || h === "127.0.0.1";
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
