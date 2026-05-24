import { createClient } from "@insforge/sdk";

/**
 * InsForge 云端（SDK OAuth/Session）。`getInsforgeBaseUrl()` 在 localhost 有 env 时同样指向云端。
 * 仪表盘用量接口仍由 `getBackendBaseUrl()` 在 localhost 返回空串走本地 CLI；排行榜单独用 `getLeaderboardBaseUrl()`。
 */
/** 云端 InsForge 原始 URL（供 proxy 目标和 edge function 调用使用） */
export function getInsforgeRemoteUrl(): string {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return (
    env?.VITE_INSFORGE_BASE_URL ||
    env?.VITE_TOKENTRACKER_BACKEND_BASE_URL ||
    ""
  ).trim();
}

function isLoopbackDashboardHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function normalizeAllowedHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.includes("*") || /\s/.test(raw)) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    if (!url.hostname || url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeAllowedHosts(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const host = normalizeAllowedHost(item);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

type ServeConfig = { allowedHosts: string[] };

let cachedServeConfig: ServeConfig = { allowedHosts: [] };

export async function loadInsforgeServeConfig(fetchImpl: typeof fetch = fetch): Promise<ServeConfig> {
  if (typeof window === "undefined" || typeof fetchImpl !== "function") return cachedServeConfig;
  try {
    const res = await fetchImpl("/api/dashboard-config", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return cachedServeConfig;
    const data = await res.json();
    cachedServeConfig = { allowedHosts: normalizeAllowedHosts(data?.allowedHosts) };
  } catch {
    // Public deployments do not serve this local CLI endpoint.
  }
  return cachedServeConfig;
}

function isLocalDashboardAuthProxyLocation(location: Location, allowedHosts: string[]): boolean {
  if (location.protocol !== "http:" && location.protocol !== "https:") return false;
  if (isLoopbackDashboardHost(location.hostname)) return true;
  return allowedHosts.includes(location.hostname.toLowerCase());
}

export function resolveInsforgeBaseUrlForLocation(
  location: Location | null | undefined,
  remoteUrl: string,
  allowedHosts = cachedServeConfig.allowedHosts,
): string {
  if (location && isLocalDashboardAuthProxyLocation(location, normalizeAllowedHosts(allowedHosts))) {
    return location.origin.replace(/\/$/, "");
  }
  return remoteUrl.trim();
}

/**
 * SDK baseUrl: local CLI/Vite dashboard origins point at themselves (same-origin
 * auth proxy, avoiding cross-origin refresh-cookie loss); public deployments
 * point directly at InsForge cloud.
 */
function getInsforgeBaseUrl(): string {
  const remoteUrl = getInsforgeRemoteUrl();
  return resolveInsforgeBaseUrlForLocation(
    typeof window !== "undefined" ? window.location : null,
    remoteUrl,
  );
}

export function getInsforgeAnonKey(): string {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return (
    env?.VITE_INSFORGE_ANON_KEY ||
    env?.VITE_TOKENTRACKER_BACKEND_ANON_KEY ||
    ""
  ).trim();
}

export function isCloudInsforgeConfigured(): boolean {
  return Boolean(getInsforgeBaseUrl());
}

/**
 * 全局单例 SDK 客户端。
 *
 * OAuth 回调时 URL 上的 `insforge_code` 只会被处理一次；若在 React 18 Strict Mode 下
 * 每次挂载都 `createClient()`，第二次实例会错过回调且会话为空，右上角头像不更新。
 */
let insforgeClientSingleton: ReturnType<typeof createClient> | null = null;

export function getOrCreateInsforgeClient(): ReturnType<typeof createClient> | null {
  if (!isCloudInsforgeConfigured()) return null;
  if (!insforgeClientSingleton) {
    insforgeClientSingleton = createClient({
      baseUrl: getInsforgeBaseUrl(),
      anonKey: getInsforgeAnonKey() || undefined,
      autoRefreshToken: true,
    });
  }
  return insforgeClientSingleton;
}
