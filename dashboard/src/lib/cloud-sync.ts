import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "./insforge-config";
import {
  clearCloudDeviceSession,
  getLastCloudSyncTs,
  getStoredDeviceSession,
  setLastCloudSyncTs,
  setStoredDeviceSession,
  type CloudDeviceSession,
} from "./cloud-sync-prefs";
import { getLocalApiAuthHeaders } from "./local-api-auth";

const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const DEVICE_TOKEN_ROTATE_AFTER_MS = 12 * 60 * 60 * 1000;

function isRemoteHttpBase(baseUrl: string): boolean {
  return typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl.trim());
}

export function shouldRotateStoredDeviceSession(
  session: CloudDeviceSession | null,
  nowMs = Date.now(),
): boolean {
  if (!session?.token || !session?.deviceId || !session?.issuedAt) return true;
  const issuedAtMs = Date.parse(session.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return true;
  return issuedAtMs + DEVICE_TOKEN_ROTATE_AFTER_MS <= nowMs;
}

async function triggerLeaderboardRefresh(accessToken: string): Promise<void> {
  const baseUrl = getInsforgeRemoteUrl();
  if (!isRemoteHttpBase(baseUrl) || !accessToken) return;
  const root = baseUrl.replace(/\/$/, "");
  const anon = getInsforgeAnonKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (anon) headers.apikey = anon;
  // Per-sync refresh is week-only. Month/Total scan tens of thousands of
  // hourly rows each call and burn InsForge Egress (~5 MB per full refresh
  // every 5 min per active user blew through the 5 GB plan). A scheduled
  // job covers the slower-moving month/total snapshots.
  try {
    await fetch(`${root}/functions/tokentracker-leaderboard-refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify({ period: "week" }),
    });
  } catch { /* best effort */ }
}

/**
 * 用当前登录 JWT 向 InsForge 签发 device token，供本地 `tokentracker sync` 上传到云端。
 */
export async function issueDeviceTokenForCloud(accessToken: string): Promise<CloudDeviceSession | null> {
  const baseUrl = getInsforgeRemoteUrl();
  if (!isRemoteHttpBase(baseUrl) || !accessToken) return null;
  const root = baseUrl.replace(/\/$/, "");
  const anon = getInsforgeAnonKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (anon) headers.apikey = anon;
  const platform =
    typeof navigator !== "undefined" && typeof navigator.platform === "string"
      ? navigator.platform
      : "web";
  // 云端 slug 为 tokentracker-device-token-issue（历史文档里的 vibeusage-* 在本项目未部署）
  const res = await fetch(`${root}/functions/tokentracker-device-token-issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      device_name: "Token Tracker (dashboard)",
      platform,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    token?: string;
    device_id?: string;
    created_at?: string;
  } | null;
  const token = typeof data?.token === "string" ? data.token : null;
  const deviceId = typeof data?.device_id === "string" ? data.device_id : null;
  if (!token || !deviceId) return null;
  const session: CloudDeviceSession = {
    token,
    deviceId,
    issuedAt: typeof data?.created_at === "string" ? data.created_at : new Date().toISOString(),
  };
  return session;
}

/**
 * 触发本地 CLI `sync`（经 dev server / tokentracker serve），可选覆盖 device token 与云端 baseUrl。
 */
export async function postLocalUsageSync(options: {
  deviceToken: string;
  insforgeBaseUrl?: string;
}): Promise<{ ok?: boolean; code?: number; stdout?: string; stderr?: string }> {
  const { deviceToken, insforgeBaseUrl } = options;
  const body: Record<string, string> = { deviceToken };
  const bu = insforgeBaseUrl || getInsforgeRemoteUrl();
  if (isRemoteHttpBase(bu)) body.insforgeBaseUrl = bu.trim();
  const authHeaders = await getLocalApiAuthHeaders();

  const res = await fetch("/functions/tokentracker-local-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as { ok?: boolean; code?: number; stdout?: string; stderr?: string };
}

async function resolveCloudDeviceSession(getAccessToken: () => Promise<string | null>): Promise<CloudDeviceSession | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const current = getStoredDeviceSession();
  if (current && !shouldRotateStoredDeviceSession(current)) {
    return current;
  }

  const issued = await issueDeviceTokenForCloud(accessToken);
  if (!issued) return null;
  setStoredDeviceSession(issued);
  return issued;
}

async function syncCloudUsageWithRecovery(getAccessToken: () => Promise<string | null>): Promise<string | null> {
  let accessToken = await getAccessToken();
  if (!accessToken) return null;

  let session = await resolveCloudDeviceSession(async () => accessToken);
  if (!session) return accessToken;

  try {
    await postLocalUsageSync({
      deviceToken: session.token,
      insforgeBaseUrl: getInsforgeRemoteUrl(),
    });
    return accessToken;
  } catch (error) {
    if (!getStoredDeviceSession()) throw error;
    clearCloudDeviceSession();
    accessToken = await getAccessToken();
    if (!accessToken) throw error;
    session = await resolveCloudDeviceSession(async () => accessToken);
    if (!session) throw error;
    await postLocalUsageSync({
      deviceToken: session.token,
      insforgeBaseUrl: getInsforgeRemoteUrl(),
    });
    return accessToken;
  }
}

/**
 * 若开启同步且具备条件：签发（或复用）device token 并运行本地 sync，将 queue 上传到云端。
 */
export async function runCloudUsageSyncIfDue(getAccessToken: () => Promise<string | null>): Promise<void> {
  const last = getLastCloudSyncTs();
  if (Date.now() - last < MIN_SYNC_INTERVAL_MS) return;

  const accessToken = await syncCloudUsageWithRecovery(getAccessToken);
  if (!accessToken) return;
  setLastCloudSyncTs(Date.now());
  await triggerLeaderboardRefresh(accessToken);
}

/** 用户打开「同步到云端」后立即尝试一次（忽略节流） */
export async function runCloudUsageSyncNow(getAccessToken: () => Promise<string | null>): Promise<void> {
  const accessToken = await syncCloudUsageWithRecovery(getAccessToken);
  if (!accessToken) return;
  setLastCloudSyncTs(Date.now());
  await triggerLeaderboardRefresh(accessToken);
}
