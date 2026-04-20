import { formatDateLocal } from "./date-range";
import {
  getMockUsageDaily,
  getMockUsageHourly,
  getMockUsageHeatmap,
  getMockUsageMonthly,
  getMockUsageModelBreakdown,
  getMockUsageSummary,
  getMockProjectUsageSummary,
  getMockLeaderboard,
  isMockEnabled,
} from "./mock-data";
import { getInsforgeRemoteUrl, getInsforgeAnonKey } from "./insforge-config";
import { isValidJwtShape } from "./auth-token";

type AnyRecord = Record<string, any>;

const PATHS = {
  usageSummary: "tokentracker-usage-summary",
  usageDaily: "tokentracker-usage-daily",
  usageHourly: "tokentracker-usage-hourly",
  usageMonthly: "tokentracker-usage-monthly",
  usageHeatmap: "tokentracker-usage-heatmap",
  usageModelBreakdown: "tokentracker-usage-model-breakdown",
  sessionBuckets: "tokentracker-session-buckets",
  projectUsageSummary: "tokentracker-project-usage-summary",
  userStatus: "tokentracker-user-status",
  localSync: "tokentracker-local-sync",
  usageLimits: "tokentracker-usage-limits",
};

async function fetchLocalJson(slug: string, params?: AnyRecord, options?: AnyRecord) {
  const url = new URL(`/functions/${slug}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    const err: any = new Error(`Request failed with HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function buildTimeZoneParams({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (tz) params.tz = tz;
  if (Number.isFinite(tzOffsetMinutes)) {
    params.tz_offset_minutes = String(Math.trunc(tzOffsetMinutes));
  }
  return params;
}

function buildFilterParams({ source, model }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const normalizedSource = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalizedSource) params.source = normalizedSource;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) params.model = normalizedModel;
  return params;
}

export async function probeBackend({ signal }: AnyRecord = {}) {
  const today = formatDateLocal(new Date());
  await fetchLocalJson(PATHS.usageSummary, { from: today, to: today }, { signal });
  return { status: 200 };
}

export async function getUsageSummary({
  from,
  to,
  source,
  model,
  timeZone,
  tzOffsetMinutes,
  rolling = false,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageSummary({ from, to, seed: accessToken, rolling });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchLocalJson(PATHS.usageSummary, { from, to, ...filterParams, ...tzParams, ...rollingParams });
}

export async function getProjectUsageSummary({
  from,
  to,
  source,
  limit,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockProjectUsageSummary({ seed: accessToken, limit });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source });
  const params: AnyRecord = { ...filterParams, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit != null) params.limit = String(limit);
  return fetchLocalJson(PATHS.projectUsageSummary, params);
}

export async function getSessionBuckets({ limit = 20 }: AnyRecord = {}) {
  return fetchLocalJson(PATHS.sessionBuckets, { limit });
}

async function fetchInsforgeFunction(slug: string, options: {
  method?: string;
  accessToken?: string;
  params?: AnyRecord;
  body?: unknown;
} = {}) {
  const baseUrl = getInsforgeRemoteUrl();
  if (!baseUrl) throw new Error("InsForge base URL not configured");
  const root = baseUrl.replace(/\/$/, "");
  const url = new URL(`${root}/functions/${slug}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const anonKey = getInsforgeAnonKey();
  if (anonKey) headers.apikey = anonKey;
  // Only attach Authorization if the token is a well-formed JWT. InsForge's
  // platform gateway validates the JWT before user code runs and returns
  // HTTP 500 (JWSError) for any malformed value — which would break
  // public endpoints like leaderboard for users whose stored token got
  // corrupted or truncated.
  if (options.accessToken && isValidJwtShape(options.accessToken)) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    ...(options.body != null ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const err: any = new Error(`Request failed with HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function getLeaderboard({
  accessToken,
  userId,
  period,
  metric,
  limit,
  offset,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockLeaderboard({ seed: accessToken || userId, period, metric, limit, offset });
  }
  // Deliberately NOT passing accessToken. Leaderboard is a public read and
  // InsForge's gateway returns opaque 500 (JWSError) for any JWT issue
  // (bad signature, expired, rotated secret). Passing user_id as a query
  // param lets the server compute `is_me` without ever touching the
  // Authorization header.
  return fetchInsforgeFunction("tokentracker-leaderboard", {
    params: { period, limit, offset, user_id: userId },
  });
}

export async function getPublicVisibility({ accessToken }: AnyRecord = {}) {
  return fetchInsforgeFunction("tokentracker-public-visibility", {
    accessToken,
    method: "GET",
  });
}

export async function setPublicVisibility({ accessToken, enabled, anonymous, display_name }: AnyRecord = {}) {
  const body: AnyRecord = {};
  if (enabled !== undefined) body.enabled = Boolean(enabled);
  if (anonymous !== undefined) body.anonymous = Boolean(anonymous);
  if (display_name !== undefined) body.display_name = String(display_name);
  return fetchInsforgeFunction("tokentracker-public-visibility", {
    accessToken,
    method: "POST",
    body,
  });
}

export async function refreshLeaderboard({ accessToken, period }: AnyRecord = {}) {
  return fetchInsforgeFunction("tokentracker-leaderboard-refresh", {
    accessToken,
    method: "POST",
    body: period ? { period } : {},
  });
}

export async function getLeaderboardProfile({
  accessToken,
  userId,
  period,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    const mock = getMockLeaderboard({ seed: accessToken, period, metric: "all", limit: 250, offset: 0 });
    const entries = Array.isArray(mock?.entries) ? mock.entries : [];
    const match = entries.find((entry: any) => entry?.user_id === userId) || null;
    return {
      period: mock?.period ?? "week",
      from: mock?.from ?? null,
      to: mock?.to ?? null,
      generated_at: mock?.generated_at ?? new Date().toISOString(),
      entry: match,
    };
  }
  return fetchInsforgeFunction("tokentracker-leaderboard-profile", {
    accessToken,
    params: { user_id: userId, period },
  });
}

export async function getUserStatus(_opts: AnyRecord = {}) {
  if (isMockEnabled()) {
    const now = new Date().toISOString();
    return {
      user_id: "local-user",
      created_at: now,
      pro: { active: false, sources: [], expires_at: null, partial: false, as_of: now },
      subscriptions: { partial: false, as_of: now, items: [] },
      install: {
        partial: false,
        as_of: now,
        has_active_device_token: false,
        has_active_device: false,
        active_device_tokens: 0,
        active_devices: 0,
        latest_token_activity_at: null,
        latest_device_seen_at: null,
      },
    };
  }
  return fetchLocalJson(PATHS.userStatus);
}

export async function triggerLocalSync({ signal }: AnyRecord = {}) {
  const response = await fetch(`/functions/${PATHS.localSync}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `Local sync request failed with HTTP ${response.status}`,
  }));
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error || payload?.message || `Local sync request failed with HTTP ${response.status}`;
    const error: any = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function getUsageModelBreakdown({
  from,
  to,
  source,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageModelBreakdown({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source });
  return fetchLocalJson(PATHS.usageModelBreakdown, { from, to, ...filterParams, ...tzParams });
}

export async function getUsageDaily({
  from,
  to,
  source,
  model,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageDaily({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model });
  return fetchLocalJson(PATHS.usageDaily, { from, to, ...filterParams, ...tzParams });
}

export async function getUsageHourly({
  day,
  source,
  model,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHourly({ day, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model });
  const params = day ? { day, ...filterParams, ...tzParams } : { ...filterParams, ...tzParams };
  return fetchLocalJson(PATHS.usageHourly, params);
}

export async function getUsageMonthly({
  months,
  to,
  source,
  model,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageMonthly({ months, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model });
  return fetchLocalJson(PATHS.usageMonthly, {
    ...(months ? { months: String(months) } : {}),
    ...(to ? { to } : {}),
    ...filterParams,
    ...tzParams,
  });
}

export async function getUsageLimits(opts: { refresh?: boolean } = {}) {
  const params = opts?.refresh ? { refresh: "1" } : undefined;
  return fetchLocalJson(PATHS.usageLimits, params);
}

export async function getUsageHeatmap({
  weeks,
  to,
  weekStartsOn,
  source,
  model,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHeatmap({ weeks, to, weekStartsOn, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model });
  return fetchLocalJson(PATHS.usageHeatmap, {
    weeks: String(weeks),
    to,
    week_starts_on: weekStartsOn,
    ...filterParams,
    ...tzParams,
  });
}
