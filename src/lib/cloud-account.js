"use strict";

// Account-aggregated (cross-device) cloud reads for the local server.
//
// The native menu-bar / tray popover talks only to the local CLI server and
// knows nothing about OAuth/JWT. To make the popover show the SAME cross-device
// totals the dashboard shows in "account view", the local server mints a
// short-lived access token from the InsForge refresh token it already relays
// (see local-api.js cookie relay) and proxies the `tokentracker-account-*` edge
// functions. Those functions mirror the local `tokentracker-usage-*` response
// schema exactly, so the popover renders the cloud payload unchanged.

const { DEFAULT_BASE_URL, DEFAULT_ANON_KEY } = require("./runtime-config");

// usage-* (local CLI) → account-* (cloud) slug map. Only these have a
// cross-device cloud equivalent; project-usage / usage-limits / category
// breakdown remain local-only and are intentionally absent here.
const USAGE_TO_ACCOUNT_SLUG = {
  "tokentracker-usage-summary": "tokentracker-account-summary",
  "tokentracker-usage-daily": "tokentracker-account-daily",
  "tokentracker-usage-hourly": "tokentracker-account-hourly",
  "tokentracker-usage-monthly": "tokentracker-account-monthly",
  "tokentracker-usage-heatmap": "tokentracker-account-heatmap",
  "tokentracker-usage-model-breakdown": "tokentracker-account-model-breakdown",
};

function accountSlugFor(usageSlug) {
  return USAGE_TO_ACCOUNT_SLUG[usageSlug] || null;
}

// Mirror of dashboard/src/contexts/InsforgeAuthContext.jsx
// `accessTokenFromRefreshPayload`: the refresh response may put the token at the
// top level or nested under `session`, in camelCase or snake_case.
function accessTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const session = data.session && typeof data.session === "object" ? data.session : null;
  const raw =
    (typeof data.accessToken === "string" && data.accessToken) ||
    (typeof data.access_token === "string" && data.access_token) ||
    (session && typeof session.accessToken === "string" && session.accessToken) ||
    (session && typeof session.access_token === "string" && session.access_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

function refreshTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const session = data.session && typeof data.session === "object" ? data.session : null;
  const raw =
    (typeof data.refreshToken === "string" && data.refreshToken) ||
    (typeof data.refresh_token === "string" && data.refresh_token) ||
    (session && typeof session.refreshToken === "string" && session.refreshToken) ||
    (session && typeof session.refresh_token === "string" && session.refresh_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

function decodeJwtExpMs(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return 0;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

// Module-level access-token cache, keyed by the refresh token that produced it.
// The popover polls frequently, so caching avoids hammering /api/auth/refresh.
let tokenCache = { refreshToken: null, accessToken: null, expMs: 0 };

function __resetCloudAccountCacheForTests() {
  tokenCache = { refreshToken: null, accessToken: null, expMs: 0 };
}

/**
 * Mint (or reuse a cached) InsForge access token from a refresh token.
 * @returns {Promise<{accessToken: string, refreshToken: string|null}|null>}
 *   null when no refresh token is available or the refresh failed.
 */
async function mintAccessToken({
  baseUrl,
  anonKey,
  refreshToken,
  fetchImpl = fetch,
  now = Date.now,
  skewMs = 60_000,
} = {}) {
  if (!refreshToken) return null;
  if (
    tokenCache.refreshToken === refreshToken &&
    tokenCache.accessToken &&
    tokenCache.expMs - skewMs > now()
  ) {
    return { accessToken: tokenCache.accessToken, refreshToken: null };
  }

  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (anonKey) headers.apikey = anonKey;

  let res;
  try {
    res = await fetchImpl(`${root}/api/auth/refresh?client_type=mobile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const accessToken = accessTokenFromRefreshPayload(data);
  if (!accessToken) return null;

  const expMs = decodeJwtExpMs(accessToken) || now() + 10 * 60_000;
  tokenCache = { refreshToken, accessToken, expMs };

  const rotated = refreshTokenFromRefreshPayload(data);
  return {
    accessToken,
    refreshToken: rotated && rotated !== refreshToken ? rotated : null,
  };
}

/**
 * GET a `tokentracker-account-*` edge function, forwarding the popover's query
 * params (minus `account`/`scope`, which are local-only routing knobs).
 */
async function fetchAccountFunction({
  baseUrl,
  anonKey,
  accessToken,
  slug,
  searchParams,
  fetchImpl = fetch,
} = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = new URL(`${root}/functions/${slug}`);
  if (searchParams && typeof searchParams.entries === "function") {
    for (const [key, value] of searchParams.entries()) {
      if (key === "account" || key === "scope") continue;
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
  if (anonKey) headers.apikey = anonKey;

  const res = await fetchImpl(url.toString(), { method: "GET", headers });
  if (!res || !res.ok) {
    const err = new Error(`Account fetch failed with HTTP ${res ? res.status : "?"}`);
    err.status = res ? res.status : 0;
    throw err;
  }
  return res.json();
}

/**
 * High-level helper used by local-api: mint a token from `refreshToken`, then
 * fetch the cross-device aggregate matching `usageSlug`.
 *
 * @returns {Promise<{data: any, rotatedRefreshToken: string|null}|null>}
 *   null when there is no cloud equivalent, no refresh token, or the refresh
 *   failed. Throws only when the account endpoint itself errors (so callers can
 *   distinguish "not signed in" from "cloud request failed").
 */
async function fetchAccountUsage({
  usageSlug,
  searchParams,
  baseUrl = DEFAULT_BASE_URL,
  anonKey = DEFAULT_ANON_KEY,
  refreshToken,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const slug = accountSlugFor(usageSlug);
  if (!slug) return null;

  const minted = await mintAccessToken({ baseUrl, anonKey, refreshToken, fetchImpl, now });
  if (!minted) return null;

  const data = await fetchAccountFunction({
    baseUrl,
    anonKey,
    accessToken: minted.accessToken,
    slug,
    searchParams,
    fetchImpl,
  });
  return { data, rotatedRefreshToken: minted.refreshToken };
}

module.exports = {
  USAGE_TO_ACCOUNT_SLUG,
  accountSlugFor,
  accessTokenFromRefreshPayload,
  refreshTokenFromRefreshPayload,
  decodeJwtExpMs,
  mintAccessToken,
  fetchAccountFunction,
  fetchAccountUsage,
  __resetCloudAccountCacheForTests,
};
