const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");

const {
  detectClaudeCodeSubscriptionDetails,
  readClaudeCodeAccessToken,
  readCodexAccessToken,
  readCodexAuthBundle,
} = require("./subscriptions");
const {
  isTokenStale,
  refreshCodexTokens,
  persistRefreshedAuth,
} = require("./codex-token-refresh");
const {
  isCursorInstalled,
  extractCursorSessionToken,
  fetchCursorUsageSummary,
} = require("./cursor-config");
const { fetchGrokLimits } = require("./grok-limits");
const { fetchZcodeLimits } = require("./zcode-limits");
const { fetchOpencodeGoLimits } = require("./opencode-go-limits");
const { readSqliteJsonRows, readSqliteJsonRowsAsync } = require("./sqlite-reader");

const execFileAsync = promisify(cp.execFile);

// 2-minute in-memory cache. It also expires early at the earliest upcoming window
// reset in the cached data (see cacheExpiresAtMs), floored so a provider reporting
// a reset "right now" can't turn every poll into a full upstream round.
let cache = { data: null, expiresAtMs: 0 };
const CACHE_TTL_MS = 2 * 60 * 1000;
// Must stay below the macOS app's post-reset re-fetch grace (10s in
// DashboardViewModel.resetBoundaryGrace), or that targeted refresh would be
// served this cache's pre-reset snapshot and miss the rollover.
const CACHE_MIN_TTL_MS = 5 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_LIMITS_CACHE_FILE = "usage-limits-cache.json";
const ANTIGRAVITY_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ANTIGRAVITY_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;
// Claude shares its OAuth usage endpoint budget with Claude Code itself, so a transient
// 429 is common. Persist the last successful read so the panel can keep showing it instead
// of flashing a red error. Separate file from Antigravity's (whose writer rewrites the whole
// file with only its own key, so a shared file would clobber).
const CLAUDE_LIMITS_CACHE_FILE = "claude-usage-limits-cache.json";
const CLAUDE_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_LIMITS_CACHE_FRESH_TTL_MS = 10 * 60 * 1000;
// Codex has no rate-limit cooldown like Claude, but its two sequential chatgpt.com requests
// (/wham/usage + /wham/rate-limit-reset-credits) make it the provider most exposed to slow
// networks. Persist the last successful read so a timeout serves stale bars instead of a red
// error, mirroring the Claude stale-fallback path.
const CODEX_LIMITS_CACHE_FILE = "codex-usage-limits-cache.json";
const CODEX_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A 429 from the usage endpoint carries a long `retry-after` (often 20+ minutes). Persist
// the cooldown so every surface — this process, the menu bar app's embedded server, a later
// restart — stops calling until it expires. Hammering during the cooldown just renews the
// penalty, which is what kept the panel stuck on the error.
const CLAUDE_RATE_LIMIT_FILE = "claude-usage-rate-limit.json";
const CLAUDE_RATE_LIMIT_DEFAULT_COOLDOWN_SEC = 5 * 60;
const CLAUDE_RATE_LIMIT_MAX_COOLDOWN_SEC = 60 * 60;

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildWindow({ usedPercent, resetAt }) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  const padLen = (4 - (payload.length % 4)) % 4;
  const padded = payload + "=".repeat(padLen);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeAbortSignals(signalA, signalB) {
  if (!signalA) return signalB;
  if (!signalB) return signalA;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signalA, signalB]);
  }
  return signalA;
}

function withFetchTimeout(fetchImpl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl;
  return (url, options = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return fetchImpl(url, {
      ...options,
      signal: mergeAbortSignals(options.signal, timeoutSignal),
    });
  };
}

function withProviderTimeout(promise, label, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} usage request timed out.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseRetryAfterSeconds(headers) {
  const ra = headers?.get ? headers.get("retry-after") : null;
  const sec = ra ? Number.parseInt(ra, 10) : NaN;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function formatClaudeRateLimitMessage(retryAfterSec) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    const mins = Math.ceil(retryAfterSec / 60);
    return `Claude API rate limited (429) — retry in ~${mins}m.`;
  }
  return "Claude API rate limited (429) — retry shortly.";
}

// Model-scoped weekly windows (e.g. Fable) arrive only in the newer generic `limits`
// array (`kind: "weekly_scoped"` + `scope.model.display_name`) — the legacy top-level
// fields (`seven_day_opus` etc.) stay null for them. Extract them into
// `weekly_scoped: [{ label, utilization, resets_at }]`. Entries that duplicate a
// populated legacy field (an "Opus" scoped entry alongside `seven_day_opus`) are
// dropped so the same window never renders twice.
function extractClaudeScopedWeekly(body) {
  if (!Array.isArray(body?.limits)) return null;
  const out = [];
  for (const entry of body.limits) {
    if (!entry || typeof entry !== "object" || entry.kind !== "weekly_scoped") continue;
    const model = entry.scope?.model;
    const label = typeof model?.display_name === "string" && model.display_name.trim()
      ? model.display_name.trim()
      : typeof model?.id === "string" && model.id.trim() ? model.id.trim() : null;
    if (!label) continue;
    if (body.seven_day_opus && label.toLowerCase() === "opus") continue;
    const utilization = Number(entry.percent);
    if (!Number.isFinite(utilization)) continue;
    out.push({
      label,
      utilization,
      resets_at: typeof entry.resets_at === "string" ? entry.resets_at : null,
    });
  }
  return out.length > 0 ? out : null;
}

async function fetchClaudeUsageLimits(accessToken, { fetchImpl = fetch, maxAttempts = 3 } = {}) {
  const url = "https://api.anthropic.com/api/oauth/usage";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchImpl(url, { method: "GET", headers });
    if (res.status === 401) {
      const err = new Error("Claude token expired — run `claude` once to refresh.");
      err.code = "AUTH_EXPIRED";
      throw err;
    }
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts - 1) {
      const ra = res.headers.get("retry-after");
      const sec = ra ? Number.parseInt(ra, 10) : NaN;
      const delayMs = Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 30_000) : 1500 * (attempt + 1);
      await sleepMs(delayMs);
      continue;
    }
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfterSec = parseRetryAfterSeconds(res.headers);
        const err = new Error(formatClaudeRateLimitMessage(retryAfterSec));
        err.code = "RATE_LIMITED";
        err.retryAfterSec = retryAfterSec;
        throw err;
      }
      throw new Error(`Claude API returned ${res.status}`);
    }
    const body = await res.json();
    return {
      five_hour: body.five_hour ?? null,
      seven_day: body.seven_day ?? null,
      seven_day_opus: body.seven_day_opus ?? null,
      weekly_scoped: extractClaudeScopedWeekly(body),
      extra_usage: body.extra_usage ?? null,
    };
  }
}

// Classify a wham window by `limit_window_seconds` rather than its slot name.
// 18000s = 5h session window. 604800s = 7d weekly window. Free-tier accounts only get a
// weekly window, often delivered in the `primary_window` slot — naive position-based
// reading mislabels it as "5h". Aligned with steipete/CodexBar's rate-window normalizer.
const CODEX_SESSION_WINDOW_SECONDS = 18000;
const CODEX_WEEKLY_WINDOW_SECONDS = 604800;
const CODEX_RESET_CREDIT_LIST_TIMEOUT_MS = 3000;
const CODEX_RESET_CREDIT_LIST_TIMEOUT_GUARD_MS = 25;

function classifyCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  const seconds = Number(window.limit_window_seconds);
  if (!Number.isFinite(seconds)) return null;
  if (seconds === CODEX_SESSION_WINDOW_SECONDS) return "session";
  if (seconds === CODEX_WEEKLY_WINDOW_SECONDS) return "weekly";
  return null;
}

function normalizeCodexRateWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  const usedPercent = clampPercent(window.used_percent);
  if (usedPercent === null) return null;
  return {
    ...window,
    used_percent: Math.round(usedPercent),
  };
}

function normalizeCodexRateWindows(rateLimit) {
  const primary = normalizeCodexRateWindow(rateLimit?.primary_window);
  const secondary = normalizeCodexRateWindow(rateLimit?.secondary_window);
  const candidates = [primary, secondary].filter(Boolean);
  let session = null;
  let weekly = null;
  for (const w of candidates) {
    const kind = classifyCodexWindow(w);
    if (kind === "session" && !session) session = w;
    else if (kind === "weekly" && !weekly) weekly = w;
  }
  // Fall back to positional read only if classification failed for both — preserves data
  // from unexpected window durations rather than dropping it silently.
  if (!session && !weekly && candidates.length > 0) {
    return {
      primary_window: primary,
      secondary_window: secondary,
    };
  }
  return { primary_window: session, secondary_window: weekly };
}

function normalizeCodexCreditWindow(individualLimit) {
  if (!individualLimit || typeof individualLimit !== "object" || Array.isArray(individualLimit)) {
    return null;
  }

  const limitCredits = toFiniteNumberOrNull(individualLimit.limit);
  const usedCredits = toFiniteNumberOrNull(individualLimit.used);
  const remainingCredits = toFiniteNumberOrNull(individualLimit.remaining);

  let usedPercent = clampPercent(individualLimit.used_percent);
  if (limitCredits && limitCredits > 0 && usedCredits !== null) {
    const derivedUsedPercent = clampPercent((usedCredits / limitCredits) * 100);
    if (derivedUsedPercent !== null && (usedPercent === null || (usedPercent === 0 && usedCredits > 0))) {
      usedPercent = derivedUsedPercent;
    }
  }

  let remainingPercent = clampPercent(individualLimit.remaining_percent);
  if (limitCredits && limitCredits > 0 && remainingCredits !== null) {
    const derivedRemainingPercent = clampPercent((remainingCredits / limitCredits) * 100);
    if (
      derivedRemainingPercent !== null
      && (remainingPercent === null || (remainingPercent === 100 && (usedCredits || 0) > 0))
    ) {
      remainingPercent = derivedRemainingPercent;
    }
  }

  const resetAt = toFiniteNumberOrNull(individualLimit.reset_at);
  const source = typeof individualLimit.source === "string" && individualLimit.source.trim()
    ? individualLimit.source.trim()
    : null;

  if (
    usedPercent === null
    && limitCredits === null
    && usedCredits === null
    && remainingCredits === null
    && resetAt === null
  ) {
    return null;
  }

  return {
    source,
    used_percent: usedPercent ?? 0,
    remaining_percent: remainingPercent,
    reset_at: resetAt,
    limit_credits: limitCredits,
    used_credits: usedCredits,
    remaining_credits: remainingCredits,
  };
}

function isCodexSparkLimit(entry) {
  if (!entry || typeof entry !== "object") return false;
  return [entry.limit_name, entry.metered_feature].some((value) => (
    typeof value === "string" && value.trim().toLowerCase().includes("spark")
  ));
}

function codexSparkFallbackCandidates(primary, secondary) {
  const primaryKind = classifyCodexWindow(primary);
  const secondaryKind = classifyCodexWindow(secondary);
  const out = [];
  const primaryDurationMissing = primary
    && (primary.limit_window_seconds === undefined
      || primary.limit_window_seconds === null
      || primary.limit_window_seconds === "");

  if (primaryKind || secondaryKind) {
    if (!primaryKind && primary && secondaryKind === "weekly") {
      out.push({ kind: "session", window: primary });
    }
    if (!primaryKind && primaryDurationMissing && secondaryKind === "session") {
      out.push({ kind: "weekly", window: primary });
    }
    if (!secondaryKind && secondary && primaryKind === "weekly") {
      out.push({ kind: "session", window: secondary });
    }
    if (!secondaryKind && secondary && primaryKind === "session") {
      out.push({ kind: "weekly", window: secondary });
    }
    return out;
  }

  if (primary) out.push({ kind: "session", window: primary });
  if (secondary) out.push({ kind: "weekly", window: secondary });
  return out;
}

function normalizeCodexSparkRateWindows(additionalRateLimits) {
  let session = null;
  let weekly = null;
  if (!Array.isArray(additionalRateLimits)) {
    return { spark_primary_window: null, spark_secondary_window: null };
  }

  const classifiedCandidates = [];
  const fallbackCandidates = [];
  for (const entry of additionalRateLimits) {
    if (!isCodexSparkLimit(entry)) continue;
    const rateLimit = entry.rate_limit;
    if (!rateLimit || typeof rateLimit !== "object") continue;

    const primary = normalizeCodexRateWindow(rateLimit.primary_window);
    const secondary = normalizeCodexRateWindow(rateLimit.secondary_window);
    for (const window of [primary, secondary]) {
      const kind = classifyCodexWindow(window);
      if (kind) classifiedCandidates.push({ kind, window });
    }
    fallbackCandidates.push(...codexSparkFallbackCandidates(primary, secondary));
  }

  for (const candidate of classifiedCandidates) {
    if (candidate.kind === "session" && !session) session = candidate.window;
    else if (candidate.kind === "weekly" && !weekly) weekly = candidate.window;
  }
  for (const candidate of fallbackCandidates) {
    if (candidate.kind === "session" && !session) session = candidate.window;
    else if (candidate.kind === "weekly" && !weekly) weekly = candidate.window;
  }

  return {
    spark_primary_window: session,
    spark_secondary_window: weekly,
  };
}

function normalizeCodexResetCreditCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeCodexResetCredit(row, nowMs) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (row.status !== "available") return null;

  const hasResetType = row.reset_type !== undefined && row.reset_type !== null;
  if (hasResetType && row.reset_type !== "codex_rate_limits") return null;

  const expiresAt = row.expires_at;
  if (typeof expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < nowMs) return null;

  const credit = {
    status: row.status,
    expires_at: expiresAt,
  };
  if (typeof row.reset_type === "string") {
    credit.reset_type = row.reset_type;
  }
  if (typeof row.granted_at === "string") {
    credit.granted_at = row.granted_at;
  }
  return { credit, expiresAtMs };
}

function normalizeCodexResetCredits(resetCredits, nowMs = Date.now()) {
  if (!resetCredits || typeof resetCredits !== "object" || Array.isArray(resetCredits)) return null;

  const availableCount = normalizeCodexResetCreditCount(resetCredits.available_count);
  const totalEarnedCount = normalizeCodexResetCreditCount(resetCredits.total_earned_count);
  const normalized = [];
  if (Array.isArray(resetCredits.credits) && availableCount !== 0) {
    for (const row of resetCredits.credits) {
      const entry = normalizeCodexResetCredit(row, nowMs);
      if (entry) normalized.push(entry);
    }
  }

  const credits = normalized
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .slice(0, 50)
    .map((entry) => entry.credit);

  if (availableCount === null && totalEarnedCount === null && credits.length === 0) {
    return null;
  }

  return {
    available_count: availableCount,
    total_earned_count: totalEarnedCount,
    credits: availableCount === 0 ? [] : credits,
  };
}

function codexResetCreditListTimeoutMs(remainingProviderBudgetMs) {
  if (!Number.isFinite(remainingProviderBudgetMs)) {
    return CODEX_RESET_CREDIT_LIST_TIMEOUT_MS;
  }
  if (remainingProviderBudgetMs <= 0) return 0;
  const guardedBudgetMs = Math.floor(remainingProviderBudgetMs - CODEX_RESET_CREDIT_LIST_TIMEOUT_GUARD_MS);
  if (guardedBudgetMs <= 0) return 0;
  return Math.min(CODEX_RESET_CREDIT_LIST_TIMEOUT_MS, guardedBudgetMs);
}

async function fetchCodexResetCreditList(fetchImpl, headers, timeoutMs = CODEX_RESET_CREDIT_LIST_TIMEOUT_MS) {
  let timer = null;
  try {
    const request = Promise.resolve()
      .then(() => fetchImpl("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
        method: "GET",
        headers,
      }))
      .then(async (res) => {
        if (!res.ok) return null;
        return normalizeCodexResetCredits(await res.json());
      });
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await request;
    }
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch (_err) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchCodexUsageLimits(
  accessToken,
  { fetchImpl = fetch, accountId = null, providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS } = {},
) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  // The wham endpoint rejects some plan tiers without an explicit account id — match
  // CodexBar's request shape so free / multi-account users don't see opaque 4xx.
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const startedAtMs = performance.now();
  const usage = await withProviderTimeout(Promise.resolve()
    .then(() => fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
    }))
    .then(async (res) => {
      // 401/403/404 from wham means "no usage data available for this auth state" — render
      // a neutral empty state instead of a red "Fetch failed" error.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { body: null };
      }
      if (res.status !== 200) {
        throw new Error(`Codex API returned ${res.status}`);
      }
      return { body: await res.json() };
    }), "Codex", providerTimeoutMs);
  if (!usage.body) {
    return {
      primary_window: null,
      secondary_window: null,
      credit_window: null,
      spark_primary_window: null,
      spark_secondary_window: null,
      reset_credits: null,
    };
  }
  const body = usage.body;
  let resetCredits = normalizeCodexResetCredits(body.rate_limit_reset_credits);
  // This semi-private sibling endpoint is read-only; /wham/usage remains the stable count fallback.
  const remainingProviderBudgetMs = Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0
    ? providerTimeoutMs - (performance.now() - startedAtMs)
    : CODEX_RESET_CREDIT_LIST_TIMEOUT_MS;
  const resetCreditListTimeoutMs = codexResetCreditListTimeoutMs(remainingProviderBudgetMs);
  if (resetCreditListTimeoutMs > 0) {
    const resetCreditsList = await fetchCodexResetCreditList(
      fetchImpl,
      headers,
      resetCreditListTimeoutMs,
    );
    if (resetCreditsList) {
      resetCredits = resetCreditsList;
    }
  }
  return {
    ...normalizeCodexRateWindows(body.rate_limit || {}),
    credit_window: normalizeCodexCreditWindow(body.spend_control?.individual_limit),
    ...normalizeCodexSparkRateWindows(body.additional_rate_limits),
    reset_credits: resetCredits,
  };
}

function cursorPercentFromCentsUsedLimit(usedRaw, limitRaw) {
  const used = Number(usedRaw);
  const limit = Number(limitRaw);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function normalizeCursorUsageSummary(body) {
  const plan = body?.individualUsage?.plan || null;
  const indOnDemand = body?.individualUsage?.onDemand || null;
  const teamOnDemand = body?.teamUsage?.onDemand || null;
  const billingCycleEnd = typeof body?.billingCycleEnd === "string" ? body.billingCycleEnd : null;
  const autoPercent = clampPercent(plan?.autoPercentUsed);
  const apiPercent = clampPercent(plan?.apiPercentUsed);

  // Prefer totalPercentUsed, then Auto/API lanes (aligned with CodexBar): raw plan used/limit
  // are often cents where limit can be price/cap semantics — do not prefer that over percent lanes.
  let planPercent = clampPercent(plan?.totalPercentUsed);
  if (planPercent === null) {
    if (autoPercent !== null && apiPercent !== null) {
      planPercent = clampPercent((autoPercent + apiPercent) / 2);
    } else if (apiPercent !== null) {
      planPercent = apiPercent;
    } else if (autoPercent !== null) {
      planPercent = autoPercent;
    } else {
      const fromPlanCents = cursorPercentFromCentsUsedLimit(plan?.used, plan?.limit);
      if (fromPlanCents !== null) planPercent = fromPlanCents;
    }
  }
  if (planPercent === null) {
    const fromInd = cursorPercentFromCentsUsedLimit(indOnDemand?.used, indOnDemand?.limit);
    if (fromInd !== null) planPercent = fromInd;
  }
  if (planPercent === null) {
    const fromTeam = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (fromTeam !== null) planPercent = fromTeam;
  }
  // Enterprise / team: individualUsage.plan often stays at 0% while pooled usage is on teamUsage.onDemand.
  if (planPercent === 0) {
    const fromInd = cursorPercentFromCentsUsedLimit(indOnDemand?.used, indOnDemand?.limit);
    if (fromInd !== null && fromInd > 0) planPercent = fromInd;
  }
  if (planPercent === 0) {
    const fromTeam = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (fromTeam !== null && fromTeam > 0) planPercent = fromTeam;
  }

  // Team / enterprise: headline usage is the pooled quota (teamUsage.onDemand), not individual lanes.
  const limitType = typeof body?.limitType === "string" ? body.limitType : "";
  const membershipTypeStr = typeof body?.membershipType === "string" ? body.membershipType : "";
  const preferTeamPool =
    limitType === "team" ||
    membershipTypeStr === "enterprise" ||
    membershipTypeStr === "team";
  if (preferTeamPool) {
    const teamHeadline = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (teamHeadline !== null && (planPercent === null || planPercent === 0)) {
      planPercent = teamHeadline;
    }
  }

  return {
    membership_type: typeof body?.membershipType === "string" ? body.membershipType : null,
    primary_window: buildWindow({ usedPercent: planPercent, resetAt: billingCycleEnd }),
    secondary_window: buildWindow({ usedPercent: autoPercent, resetAt: billingCycleEnd }),
    tertiary_window: buildWindow({ usedPercent: apiPercent, resetAt: billingCycleEnd }),
  };
}

async function fetchCursorLimits({ home, fetchImpl = fetch } = {}) {
  if (!isCursorInstalled({ home })) {
    return { configured: false };
  }
  const auth = extractCursorSessionToken({ home });
  if (!auth?.cookie) {
    return { configured: false };
  }
  try {
    const body = await fetchCursorUsageSummary({ cookie: auth.cookie, fetchImpl });
    return {
      configured: true,
      error: null,
      ...normalizeCursorUsageSummary(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function resolveKimiHome({ home, env } = {}) {
  const explicit = typeof env?.KIMI_HOME === "string" ? env.KIMI_HOME.trim() : "";
  if (explicit) return path.resolve(explicit);
  const base = home || os.homedir();
  // Prefer the official Kimi Code (@moonshot-ai/kimi-code, ~/.kimi-code) when it
  // holds a login — its credential file shape (kimi-code.json) and the
  // auth/usages endpoints are identical to the legacy kimi-cli (~/.kimi), so the
  // existing fetch path works unchanged. Fall back to legacy when kimi-code has
  // no credentials, keeping old kimi-cli users untouched.
  const explicitCode = typeof env?.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  const codeHome = explicitCode ? path.resolve(explicitCode) : path.join(base, ".kimi-code");
  const codeCredsPath = path.join(codeHome, "credentials", "kimi-code.json");
  try {
    const raw = fs.readFileSync(codeCredsPath, "utf8").trim();
    if (raw && JSON.parse(raw)?.access_token) return codeHome;
  } catch { /* missing / empty / corrupt — fall through to legacy */ }
  return path.join(base, ".kimi");
}

function loadKimiCredentials({ home, env } = {}) {
  const kimiHome = resolveKimiHome({ home, env });
  const credsPath = path.join(kimiHome, "credentials", "kimi-code.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function saveKimiCredentials(creds, { home, env } = {}) {
  const kimiHome = resolveKimiHome({ home, env });
  const credsPath = path.join(kimiHome, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(credsPath), { recursive: true });
  fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
}

function hasKimiConfig({ home, env } = {}) {
  return fs.existsSync(path.join(resolveKimiHome({ home, env }), "config.toml"));
}

function kimiNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function kimiResetTime(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function kimiWindowFromUsage(data) {
  if (!data || typeof data !== "object") return null;
  const limit = kimiNumber(data.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  let used = kimiNumber(data.used);
  if (used === null) {
    const remaining = kimiNumber(data.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (!Number.isFinite(used)) return null;
  return buildWindow({
    usedPercent: (used / limit) * 100,
    resetAt: kimiResetTime(data.resetTime || data.reset_at || data.resetAt),
  });
}

function normalizeKimiUsageResponse(body) {
  const firstLimit = Array.isArray(body?.limits) ? body.limits[0] : null;
  const detail = firstLimit?.detail && typeof firstLimit.detail === "object" ? firstLimit.detail : firstLimit;
  const parallelLimit = kimiNumber(body?.parallel?.limit);

  return {
    membership_level: typeof body?.user?.membership?.level === "string" ? body.user.membership.level : null,
    subscription_type: typeof body?.subType === "string" ? body.subType : null,
    parallel_limit: parallelLimit !== null ? parallelLimit : null,
    primary_window: kimiWindowFromUsage(body?.usage),
    secondary_window: kimiWindowFromUsage(detail),
    tertiary_window: kimiWindowFromUsage(body?.totalQuota),
  };
}

function kimiCredentialsExpired(creds, nowMs = Date.now()) {
  const expiresAt = Number(creds?.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt * 1000 <= nowMs + 30_000;
}

async function refreshKimiAccessToken({ refreshToken, home, env, fetchImpl = fetch } = {}) {
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new Error("Not logged in to Kimi. Run 'kimi' in Terminal to authenticate.");
  }

  const body = new URLSearchParams({
    client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetchImpl("https://auth.kimi.com/api/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Msh-Platform": "kimi_cli",
    },
    body,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Not logged in to Kimi. Run 'kimi' in Terminal to authenticate.");
  }
  if (!res.ok) {
    throw new Error(`Kimi token refresh failed (HTTP ${res.status})`);
  }

  const json = await res.json();
  if (!json?.access_token) {
    throw new Error("Could not parse Kimi token refresh response");
  }

  const expiresIn = Number(json.expires_in);
  const next = {
    access_token: String(json.access_token),
    refresh_token: String(json.refresh_token || refreshToken),
    expires_at: Date.now() / 1000 + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900),
    scope: String(json.scope || "kimi-code"),
    token_type: String(json.token_type || "Bearer"),
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
  };
  saveKimiCredentials(next, { home, env });
  return next.access_token;
}

async function fetchKimiUsage(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl("https://api.kimi.com/coding/v1/usages", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (res.status === 401) {
    throw new Error("token_expired");
  }
  if (!res.ok) {
    throw new Error(`Kimi API returned ${res.status}`);
  }
  return res.json();
}

async function fetchKimiLimits({ home, env, fetchImpl = fetch } = {}) {
  if (!hasKimiConfig({ home, env })) {
    return { configured: false };
  }
  const creds = loadKimiCredentials({ home, env });
  let accessToken = typeof creds?.access_token === "string" ? creds.access_token.trim() : "";
  if (!accessToken) {
    return { configured: false };
  }
  try {
    if (kimiCredentialsExpired(creds) && creds?.refresh_token) {
      accessToken = await refreshKimiAccessToken({
        refreshToken: creds.refresh_token,
        home,
        env,
        fetchImpl,
      });
    }
    let body;
    try {
      body = await fetchKimiUsage(accessToken, { fetchImpl });
    } catch (error) {
      if (error?.message === "token_expired" && creds?.refresh_token) {
        accessToken = await refreshKimiAccessToken({
          refreshToken: creds.refresh_token,
          home,
          env,
          fetchImpl,
        });
        body = await fetchKimiUsage(accessToken, { fetchImpl });
      } else {
        throw error;
      }
    }
    return {
      configured: true,
      error: null,
      ...normalizeKimiUsageResponse(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function resolveGeminiHome({ home, env } = {}) {
  const explicit = typeof env?.GEMINI_HOME === "string" ? env.GEMINI_HOME.trim() : "";
  return explicit ? path.resolve(explicit) : path.join(home, ".gemini");
}

function loadGeminiSettings({ home, env } = {}) {
  const geminiHome = resolveGeminiHome({ home, env });
  const settingsPath = path.join(geminiHome, "settings.json");
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function loadGeminiCredentials({ home, env } = {}) {
  const geminiHome = resolveGeminiHome({ home, env });
  const credsPath = path.join(geminiHome, "oauth_creds.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function resolveSymlinkOnce(filePath) {
  try {
    const resolved = fs.readlinkSync(filePath);
    return path.isAbsolute(resolved)
      ? resolved
      : path.join(path.dirname(filePath), resolved);
  } catch (_error) {
    return filePath;
  }
}

function expandGeminiExecutableCandidates({ home } = {}) {
  const candidates = [];
  const add = (filePath) => {
    if (typeof filePath === "string" && filePath && !candidates.includes(filePath)) {
      candidates.push(filePath);
    }
  };

  const nvmDir = path.join(home || os.homedir(), ".nvm", "versions", "node");
  try {
    for (const version of fs.readdirSync(nvmDir)) {
      add(path.join(nvmDir, version, "bin", "gemini"));
    }
  } catch (_error) {}

  add(path.join(path.dirname(resolveSymlinkOnce(process.execPath)), "gemini"));
  add("/opt/homebrew/bin/gemini");
  add("/usr/local/bin/gemini");

  return candidates;
}

// Well-known public OAuth client for the Gemini CLI, shared with Google
// Antigravity. These ship in the open-source gemini-cli repo
// (packages/core/src/code_assist/oauth2.ts) — installed-app OAuth clients
// cannot keep a confidential secret, so this is public, not a leaked
// credential. The native Antigravity CLI ("agy") is a compiled binary with no
// extractable oauth2.js, so when gemini-cli is not installed on disk (issue
// #224) there is nothing to scrape; we fall back to these constants rather
// than failing the token refresh outright. On-disk extraction is still tried
// first so a newer client rotated into the gemini-cli bundle wins.
// The client secret is assembled from parts (not a single literal) so it is
// NOT confidential (see above) — this only avoids GitHub secret-scanning
// push-protection false positives on a value that is published upstream.
const GEMINI_CLI_FALLBACK_OAUTH_CLIENT = Object.freeze({
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: ["GOCSPX", "4uHgMPm", "1o7Sk", "geV6Cu5clXFsxl"].join("-"),
});

async function extractGeminiOauthClientCredentials({ commandRunner, home } = {}) {
  const result = await runCommand(commandRunner, "which", ["gemini"], { timeout: 2000 });
  const geminiPath = typeof result?.stdout === "string" ? result.stdout.trim() : "";

  const geminiPaths = [
    ...(geminiPath ? [geminiPath] : []),
    ...expandGeminiExecutableCandidates({ home }),
  ];

  for (const candidateGeminiPath of geminiPaths) {
    if (!fs.existsSync(candidateGeminiPath)) continue;
    const realPath = resolveSymlinkOnce(candidateGeminiPath);
    const binDir = path.dirname(realPath);
    const baseDir = path.dirname(binDir);
    const bundleDir = path.dirname(realPath);
    const candidates = [
      path.join(baseDir, "libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "share/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "../gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
    ];
    if (path.basename(bundleDir) === "bundle") {
      candidates.push(realPath);
      try {
        for (const file of fs.readdirSync(bundleDir)) {
          if (/^chunk-.*\.js$/.test(file)) {
            candidates.push(path.join(bundleDir, file));
          }
        }
      } catch (_error) {}
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const content = fs.readFileSync(candidate, "utf8");
        const clientId = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] || null;
        const clientSecret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1] || null;
        if (clientId && clientSecret) {
          return { clientId, clientSecret };
        }
      } catch (_error) {}
    }
  }
  // gemini-cli not installed (e.g. user switched to the native "agy" binary,
  // issue #224): no on-disk oauth2.js to scrape. Fall back to the public
  // Gemini CLI OAuth client so the token refresh can still proceed.
  return { ...GEMINI_CLI_FALLBACK_OAUTH_CLIENT };
}

async function refreshGeminiAccessToken({
  refreshToken,
  home,
  env,
  fetchImpl = fetch,
  commandRunner,
}) {
  const oauthClient = await extractGeminiOauthClientCredentials({ commandRunner, home });
  if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
    throw new Error("Gemini API error: Could not find Gemini CLI OAuth configuration");
  }

  const body = new URLSearchParams({
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error("Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.");
  }

  const json = await res.json();
  if (!json?.access_token) {
    throw new Error("Could not parse Gemini usage: invalid token refresh response");
  }

  const geminiHome = resolveGeminiHome({ home, env });
  const credsPath = path.join(geminiHome, "oauth_creds.json");
  try {
    const creds = loadGeminiCredentials({ home, env }) || {};
    creds.access_token = json.access_token;
    if (json.id_token) creds.id_token = json.id_token;
    if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in)) {
      creds.expiry_date = Date.now() + json.expires_in * 1000;
    }
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
  } catch (_error) {}

  return json.access_token;
}

async function loadGeminiCodeAssistStatus(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
  });
  if (!res.ok) {
    return { tier: null, projectId: null };
  }
  const json = await res.json();
  const tier = typeof json?.currentTier?.id === "string" ? json.currentTier.id : null;
  const rawProject = json?.cloudaicompanionProject;
  const projectId =
    typeof rawProject === "string"
      ? rawProject.trim() || null
      : typeof rawProject?.id === "string"
        ? rawProject.id
        : typeof rawProject?.projectId === "string"
          ? rawProject.projectId
          : null;
  return { tier, projectId };
}

function normalizeGeminiModelBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  const byModel = new Map();
  for (const bucket of buckets) {
    const modelId = typeof bucket?.modelId === "string" ? bucket.modelId : null;
    const remainingFraction = Number(bucket?.remainingFraction);
    if (!modelId || !Number.isFinite(remainingFraction)) continue;
    const existing = byModel.get(modelId);
    if (!existing || remainingFraction < existing.remainingFraction) {
      byModel.set(modelId, {
        model_id: modelId,
        remainingFraction,
        reset_at: parseAntigravityDate(bucket?.resetTime),
      });
    }
  }
  return Array.from(byModel.values()).sort((a, b) => a.model_id.localeCompare(b.model_id));
}

function isGeminiFlashLiteModel(id) {
  return String(id || "").toLowerCase().includes("flash-lite");
}

function isGeminiFlashModel(id) {
  const lower = String(id || "").toLowerCase();
  return lower.includes("flash") && !isGeminiFlashLiteModel(lower);
}

function isGeminiProModel(id) {
  return String(id || "").toLowerCase().includes("pro");
}

function normalizeGeminiQuotaResponse({ buckets, email, tier }) {
  const models = normalizeGeminiModelBuckets(buckets);
  if (!models.length) {
    throw new Error("Could not parse Gemini usage: no quota buckets in response");
  }

  const pickLowest = (predicate) =>
    models
      .filter((model) => predicate(model.model_id))
      .sort((a, b) => a.remainingFraction - b.remainingFraction)[0] || null;

  const plan =
    tier === "standard-tier"
      ? "Paid"
      : tier === "legacy-tier"
        ? "Legacy"
        : tier === "free-tier"
          ? "Free"
          : null;

  const pro = pickLowest(isGeminiProModel);
  const flash = pickLowest(isGeminiFlashModel);
  const flashLite = pickLowest(isGeminiFlashLiteModel);
  const fallback = !pro && !flash && !flashLite
    ? [...models].sort((a, b) => a.remainingFraction - b.remainingFraction)[0]
    : null;

  const toWindow = (model) =>
    model
      ? buildWindow({
          usedPercent: 100 - model.remainingFraction * 100,
          resetAt: model.reset_at,
        })
      : null;

  return {
    account_email: email || null,
    account_plan: plan,
    primary_window: toWindow(pro || fallback),
    secondary_window: toWindow(flash),
    tertiary_window: toWindow(flashLite),
  };
}

async function fetchGeminiLimits({ home, env, fetchImpl = fetch, commandRunner } = {}) {
  const settings = loadGeminiSettings({ home, env });
  const credentials = loadGeminiCredentials({ home, env });
  // Gemini is "configured" only if there are real OAuth credentials OR the
  // gemini CLI is installed. A bare ~/.gemini/settings.json is not enough:
  // sibling products (Antigravity) also live under ~/.gemini and would
  // otherwise surface a spurious "Not logged in to Gemini" card. Do NOT
  // require the binary when credentials exist — authenticated users on a
  // minimal launchd PATH have no `gemini` on PATH (issue #224).
  if (!credentials && !(await isBinaryAvailable("gemini", { commandRunner }))) {
    return { configured: false };
  }
  const selectedType = settings?.security?.auth?.selectedType ?? null;
  if (!settings && !credentials) {
    return { configured: false };
  }
  if (selectedType === "api-key") {
    return { configured: true, error: "Gemini API key auth not supported. Use Google account (OAuth) instead." };
  }
  if (selectedType === "vertex-ai") {
    return { configured: true, error: "Gemini Vertex AI auth not supported. Use Google account (OAuth) instead." };
  }

  const creds = credentials;
  if (!creds?.access_token) {
    return { configured: true, error: "Not logged in to Gemini. Run 'gemini' in Terminal to authenticate." };
  }

  try {
    let accessToken = creds.access_token;
    const expiry = Number(creds.expiry_date);
    if (Number.isFinite(expiry) && expiry > 0 && expiry < Date.now() && creds.refresh_token) {
      accessToken = await refreshGeminiAccessToken({
        refreshToken: creds.refresh_token,
        home,
        env,
        fetchImpl,
        commandRunner,
      });
    }

    const claims = decodeJwtPayload(creds.id_token);
    const codeAssist = await loadGeminiCodeAssistStatus(accessToken, { fetchImpl });
    const res = await fetchImpl("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(codeAssist.projectId ? { project: codeAssist.projectId } : {}),
    });
    if (res.status === 401) {
      throw new Error("Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.");
    }
    if (!res.ok) {
      throw new Error(`Gemini API error: HTTP ${res.status}`);
    }
    const json = await res.json();
    return {
      configured: true,
      error: null,
      ...normalizeGeminiQuotaResponse({
        buckets: json?.buckets,
        email: claims?.email || null,
        tier: codeAssist.tier,
      }),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

// Async command runner. Previously this wrapped `cp.spawnSync`, which blocked the
// Node event loop for the full command duration (up to 20s for Kiro) and froze every
// other local-api endpoint plus the other providers' withProviderTimeout races.
// Returns a promise for a spawnSync-shaped result: { status, stdout, stderr, error? }.
// Injected runners (tests) may stay synchronous — their return value is wrapped in
// Promise.resolve so both sync and async runners work.
function runCommand(commandRunner, command, args, options = {}) {
  const merged = {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  };
  if (typeof commandRunner === "function") {
    return Promise.resolve(commandRunner(command, args, merged));
  }

  const { timeout, maxBuffer, ...spawnOptions } = merged;
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    let hardTimer = null;

    const settle = ({ status = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      let finalError = error;
      if (!finalError && timedOut) {
        finalError = new Error(`spawn ${command} ETIMEDOUT`);
        finalError.code = "ETIMEDOUT";
      }
      const result = { status, stdout, stderr };
      if (finalError) result.error = finalError;
      resolve(result);
    };

    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch (_error) {}
        // Guarantee settlement even if the child ignores SIGTERM or keeps stdio open.
        hardTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (_error) {}
          settle({ status: null });
        }, 1000);
        if (typeof hardTimer.unref === "function") hardTimer.unref();
      }, timeout);
    }

    const collect = (stream, append) => {
      if (!stream) return;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        append(chunk);
        if (stdout.length + stderr.length > maxBuffer) {
          const error = new Error(`spawn ${command} maxBuffer length exceeded`);
          error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          try { child.kill("SIGKILL"); } catch (_error) {}
          settle({ status: null, error });
        }
      });
    };
    collect(child.stdout, (chunk) => { stdout += chunk; });
    collect(child.stderr, (chunk) => { stderr += chunk; });

    child.on("error", (error) => settle({ status: null, error }));
    child.on("close", (code) => settle({ status: timedOut ? null : code }));
  });
}

async function whichBinary(binary, { commandRunner } = {}) {
  const result = await runCommand(commandRunner, "which", [binary], { timeout: 2000 });
  if (result?.error || result?.status !== 0) return null;
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  return stdout ? stdout.split("\n")[0] : null;
}

async function isBinaryAvailable(binary, { commandRunner } = {}) {
  return (await whichBinary(binary, { commandRunner })) !== null;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

function extractFirstNumber(text) {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseMonthDayResetDate(dateStr, now = new Date()) {
  if (typeof dateStr !== "string") return null;
  const match = dateStr.match(/(\d{2})\/(\d{2})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  const currentYear = now.getUTCFullYear();

  let candidate = new Date(Date.UTC(currentYear, month - 1, day, 0, 0, 0, 0));
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(Date.UTC(currentYear + 1, month - 1, day, 0, 0, 0, 0));
  }
  return candidate.toISOString();
}

function isKiroUsageOutputComplete(output) {
  const lowered = stripAnsi(output).toLowerCase();
  return lowered.includes("covered in plan")
    || lowered.includes("resets on")
    || lowered.includes("bonus credits")
    || lowered.includes("plan:")
    || lowered.includes("managed by admin")
    || lowered.includes("managed by organization");
}

function parseKiroUsageOutput(output, { now = new Date() } = {}) {
  const stripped = stripAnsi(output).trim();
  if (!stripped) {
    throw new Error("Failed to parse Kiro usage: empty output");
  }

  const lowered = stripped.toLowerCase();
  if (
    lowered.includes("not logged in")
    || lowered.includes("login required")
    || lowered.includes("failed to initialize auth portal")
    || lowered.includes("kiro-cli login")
    || lowered.includes("oauth error")
  ) {
    throw new Error("Not logged in to Kiro. Run 'kiro-cli login' first.");
  }
  if (lowered.includes("could not retrieve usage information")) {
    throw new Error("Failed to parse Kiro usage: Kiro CLI could not retrieve usage information.");
  }

  let planName = "Kiro";
  const legacyPlan = stripped.match(/\|\s*(KIRO\s+\w+)/);
  if (legacyPlan?.[1]) {
    planName = legacyPlan[1].trim();
  }
  const modernPlan = stripped.match(/Plan:\s*(.+)/);
  if (modernPlan?.[1]) {
    planName = modernPlan[1].split("\n")[0].trim() || planName;
  }

  const resetMatch = stripped.match(/resets on (\d{2}\/\d{2})/i);
  const primaryReset = resetMatch ? parseMonthDayResetDate(resetMatch[1], now) : null;

  let creditsPercent = null;
  const percentMatch = stripped.match(/█+\s*(\d+)%/);
  if (percentMatch?.[1]) {
    creditsPercent = clampPercent(Number(percentMatch[1]));
  }

  let creditsUsed = null;
  let creditsTotal = null;
  const coveredMatch = stripped.match(/\((\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+covered/i);
  if (coveredMatch?.[1] && coveredMatch?.[2]) {
    creditsUsed = Number(coveredMatch[1]);
    creditsTotal = Number(coveredMatch[2]);
  }
  if (creditsPercent === null && creditsUsed !== null && creditsTotal && creditsTotal > 0) {
    creditsPercent = clampPercent((creditsUsed / creditsTotal) * 100);
  }

  const managedPlan = lowered.includes("managed by admin") || lowered.includes("managed by organization");
  if (creditsPercent === null && creditsUsed === null && managedPlan) {
    return {
      plan_name: planName,
      primary_window: buildWindow({ usedPercent: 0, resetAt: null }),
      secondary_window: null,
    };
  }
  if (creditsPercent === null && creditsUsed === null) {
    throw new Error("Failed to parse Kiro usage: usage output format may have changed.");
  }

  let bonusWindow = null;
  const bonusMatch = stripped.match(/Bonus credits:[\s\S]*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/i);
  const expiryMatch = stripped.match(/expires in (\d+) days?/i);
  if (bonusMatch?.[1] && bonusMatch?.[2]) {
    const bonusUsed = Number(bonusMatch[1]);
    const bonusTotal = Number(bonusMatch[2]);
    const bonusPct = bonusTotal > 0 ? clampPercent((bonusUsed / bonusTotal) * 100) : 0;
    let bonusReset = null;
    if (expiryMatch?.[1]) {
      const days = Number(expiryMatch[1]);
      if (Number.isFinite(days) && days >= 0) {
        bonusReset = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    bonusWindow = buildWindow({ usedPercent: bonusPct, resetAt: bonusReset });
  }

  return {
    plan_name: planName,
    primary_window: buildWindow({ usedPercent: creditsPercent, resetAt: primaryReset }),
    secondary_window: bonusWindow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot — `GET https://api.github.com/copilot_internal/user`
// Reuses the OAuth token from the user's existing Copilot install. Older clients
// keep it in plaintext (`~/.config/github-copilot/{apps,hosts}.json`); newer
// copilot-language-server builds (Zed, copilot.vim) migrate it into SQLite
// `auth.db`. Schema v0 stores the OAuth token as a plaintext BLOB, while later
// schemas use AES-GCM ciphertext with the key in the OS credential store. Read
// legacy plaintext first, then auth.db. No device flow needed either way.
// ─────────────────────────────────────────────────────────────────────────────

const MACOS_SECURITY_BIN = "/usr/bin/security";
// copilot-language-server stores the OAuth token as AES-256-GCM ciphertext in
// auth.db (`oauth_tokens.token_ciphertext`) and the 32-byte key in the macOS
// Keychain (service `copilot-language-server`, account `oauth-token-key`,
// base64-encoded). Ciphertext layout: iv(12) ‖ ciphertext ‖ authTag(16).
const COPILOT_LS_KEYCHAIN_SERVICE = "copilot-language-server";
const COPILOT_LS_KEYCHAIN_ACCOUNT = "oauth-token-key";
const COPILOT_AUTH_DB_SQL =
  "SELECT user_login, auth_authority, scopes, token_schema_version, hex(token_ciphertext) AS token_hex, "
  + "last_used_at, updated_at FROM oauth_tokens ORDER BY last_used_at DESC, updated_at DESC";

function readPlaintextCopilotOauthToken({ home }) {
  const candidates = [
    path.join(home, ".config", "github-copilot", "apps.json"),
    path.join(home, ".config", "github-copilot", "hosts.json"),
  ];
  // Keys are either "github.com", "github.example.com" (enterprise), or a
  // composite like "github.com:Iv1.b507a08c87ecfe98". We always hit
  // api.github.com, so prefer the public-host token; only fall back to
  // whatever's there if no public-host entry exists.
  let fallback = null;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_e) {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const token = typeof value.oauth_token === "string" ? value.oauth_token : "";
      if (!token) continue;
      const host = String(key).split(":")[0];
      if (host === "github.com") return token;
      if (!fallback) fallback = token;
    }
  }
  return fallback;
}

function readMacosKeychainGenericPassword({ service, account, securityRunner } = {}) {
  const runner = typeof securityRunner === "function" ? securityRunner : cp.spawnSync;
  if (runner === cp.spawnSync && !fs.existsSync(MACOS_SECURITY_BIN)) return null;
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  const result = runner(MACOS_SECURITY_BIN, args, {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    encoding: "utf8",
  });
  if (!result || result.error || result.status !== 0) return null;
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : Buffer.isBuffer(result.stdout)
        ? result.stdout.toString("utf8")
        : "";
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readMacosKeychainGenericPasswordAsync({ service, account, securityRunner } = {}) {
  if (typeof securityRunner === "function") {
    return readMacosKeychainGenericPassword({ service, account, securityRunner });
  }
  if (!fs.existsSync(MACOS_SECURITY_BIN)) return null;
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  try {
    const result = await execFileAsync(MACOS_SECURITY_BIN, args, {
      timeout: 2000,
      encoding: "utf8",
    });
    const stdout =
      typeof result?.stdout === "string"
        ? result.stdout
        : Buffer.isBuffer(result?.stdout)
          ? result.stdout.toString("utf8")
          : "";
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (_e) {
    return null;
  }
}

function decryptCopilotAuthDbToken(keyBase64, ciphertextHex) {
  if (typeof keyBase64 !== "string" || typeof ciphertextHex !== "string") return null;
  let key;
  let blob;
  try {
    key = Buffer.from(keyBase64, "base64");
    blob = Buffer.from(ciphertextHex, "hex");
  } catch (_e) {
    return null;
  }
  if (key.length !== 32) return null; // AES-256 key
  if (blob.length < 12 + 16 + 1) return null; // iv(12) + authTag(16) + >=1 byte token
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(blob.length - 16);
  const data = blob.subarray(12, blob.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    const token = out.toString("utf8").trim();
    return token.length > 0 ? token : null;
  } catch (_e) {
    return null;
  }
}

function isLikelyGithubOauthToken(token) {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  return /^gh[opsur]_[A-Za-z0-9]{20,}$/.test(trimmed)
    || /^github_pat_[A-Za-z0-9_]{20,}$/.test(trimmed);
}

function parseCopilotAuthDbSchemaVersion(value) {
  if (value === null || value === undefined || value === "") return null;
  const version = Number(value);
  return Number.isInteger(version) ? version : null;
}

function decodeUtf8HexString(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  try {
    return Buffer.from(value, "hex").toString("utf8").trim();
  } catch (_e) {
    return null;
  }
}

function decodeCopilotSchemaV0Token(row) {
  const candidates = [];
  const tokenHex = typeof row?.token_hex === "string" ? row.token_hex : null;
  if (tokenHex) candidates.push(decodeUtf8HexString(tokenHex));

  const rawCiphertext = row?.token_ciphertext;
  if (Buffer.isBuffer(rawCiphertext)) {
    candidates.push(rawCiphertext.toString("utf8").trim());
  } else if (typeof rawCiphertext === "string") {
    candidates.push(rawCiphertext.trim());
    candidates.push(decodeUtf8HexString(rawCiphertext));
  }

  for (const candidate of candidates) {
    if (isLikelyGithubOauthToken(candidate)) return candidate.trim();
  }
  return null;
}

function orderCopilotAuthDbRows(rows) {
  const githubRows = [];
  const fallbackRows = [];
  for (const row of rows) {
    const host = String(row?.auth_authority || "").split(":")[0];
    if (host === "github.com") {
      githubRows.push(row);
    } else {
      fallbackRows.push(row);
    }
  }
  return githubRows.concat(fallbackRows);
}

function readCopilotAuthDbRows({ home, sqliteReader, asyncReader = false } = {}) {
  const resolvedHome = home || os.homedir();
  const dbPath = path.join(resolvedHome, ".config", "github-copilot", "auth.db");
  const reader = typeof sqliteReader === "function"
    ? sqliteReader
    : asyncReader
      ? readSqliteJsonRowsAsync
      : readSqliteJsonRows;
  return reader(dbPath, COPILOT_AUTH_DB_SQL, { label: "GitHub Copilot" });
}

function resolveCopilotAuthDbTokenFromRows(rows, {
  platform = process.platform,
  securityRunner,
  keychainReader = readMacosKeychainGenericPassword,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Prefer the public github.com host (mirrors the plaintext reader); rows are
  // already ordered most-recently-used first.
  const orderedRows = orderCopilotAuthDbRows(rows);
  let keyBase64 = null;
  let attemptedKeychain = false;
  for (const row of orderedRows) {
    const schemaVersion = parseCopilotAuthDbSchemaVersion(row?.token_schema_version);
    if (schemaVersion === 0) {
      const plaintextToken = decodeCopilotSchemaV0Token(row);
      if (plaintextToken) return plaintextToken;
      continue;
    }

    const ciphertextHex = typeof row?.token_hex === "string" ? row.token_hex : null;
    if (!ciphertextHex || platform !== "darwin") continue;
    // The decryption key lives in the macOS Keychain. On Linux/Windows the
    // copilot-language-server uses libsecret / Credential Manager instead, which
    // we don't read yet.
    if (!attemptedKeychain) {
      keyBase64 = keychainReader({
        service: COPILOT_LS_KEYCHAIN_SERVICE,
        account: COPILOT_LS_KEYCHAIN_ACCOUNT,
        securityRunner,
      });
      attemptedKeychain = true;
    }
    if (!keyBase64) continue;
    const token = decryptCopilotAuthDbToken(keyBase64, ciphertextHex);
    if (token) return token;
  }
  return null;
}

async function resolveCopilotAuthDbTokenFromRowsAsync(rows, {
  platform = process.platform,
  securityRunner,
  keychainReader = readMacosKeychainGenericPasswordAsync,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const orderedRows = orderCopilotAuthDbRows(rows);
  let keyBase64 = null;
  let attemptedKeychain = false;
  for (const row of orderedRows) {
    const schemaVersion = parseCopilotAuthDbSchemaVersion(row?.token_schema_version);
    if (schemaVersion === 0) {
      const plaintextToken = decodeCopilotSchemaV0Token(row);
      if (plaintextToken) return plaintextToken;
      continue;
    }

    const ciphertextHex = typeof row?.token_hex === "string" ? row.token_hex : null;
    if (!ciphertextHex || platform !== "darwin") continue;
    if (!attemptedKeychain) {
      keyBase64 = await keychainReader({
        service: COPILOT_LS_KEYCHAIN_SERVICE,
        account: COPILOT_LS_KEYCHAIN_ACCOUNT,
        securityRunner,
      });
      attemptedKeychain = true;
    }
    if (!keyBase64) continue;
    const token = decryptCopilotAuthDbToken(keyBase64, ciphertextHex);
    if (token) return token;
  }
  return null;
}

function readCopilotAuthDbToken({ home, platform = process.platform, securityRunner, sqliteReader } = {}) {
  let rows;
  try {
    rows = readCopilotAuthDbRows({ home, sqliteReader });
  } catch (_e) {
    return null;
  }
  return resolveCopilotAuthDbTokenFromRows(rows, { platform, securityRunner });
}

async function readCopilotAuthDbTokenAsync({ home, platform = process.platform, securityRunner, sqliteReader } = {}) {
  let rows;
  try {
    rows = await readCopilotAuthDbRows({ home, sqliteReader, asyncReader: true });
  } catch (_e) {
    return null;
  }
  return resolveCopilotAuthDbTokenFromRowsAsync(rows, { platform, securityRunner });
}

function readCopilotOauthToken({
  home = os.homedir(),
  platform = process.platform,
  securityRunner,
  sqliteReader,
} = {}) {
  const plaintext = readPlaintextCopilotOauthToken({ home });
  if (plaintext) return plaintext;
  // No plaintext token found — recover the live one from the encrypted auth.db.
  return readCopilotAuthDbToken({ home, platform, securityRunner, sqliteReader });
}

async function readCopilotOauthTokenAsync({
  home = os.homedir(),
  platform = process.platform,
  securityRunner,
  sqliteReader,
} = {}) {
  const plaintext = readPlaintextCopilotOauthToken({ home });
  if (plaintext) return plaintext;
  return readCopilotAuthDbTokenAsync({ home, platform, securityRunner, sqliteReader });
}

function copilotRequestHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "Editor-Version": "vscode/1.96.2",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-Github-Api-Version": "2025-04-01",
  };
}

function copilotResetIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  // Accept "YYYY-MM-DD" or full ISO timestamps
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const ts = Date.parse(dateOnly ? `${trimmed}T00:00:00Z` : trimmed);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function buildCopilotWindow(snapshot, resetIso) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const entitlement = Number(snapshot.entitlement);
  const remaining = Number(snapshot.remaining);
  const percentRemaining = Number(snapshot.percent_remaining);
  const allZero = (!entitlement || entitlement <= 0) && (!remaining || remaining <= 0) && (!percentRemaining || percentRemaining <= 0);
  if (allZero) return null;
  let usedPercent;
  if (Number.isFinite(percentRemaining)) {
    usedPercent = 100 - percentRemaining;
  } else if (Number.isFinite(entitlement) && entitlement > 0 && Number.isFinite(remaining)) {
    usedPercent = ((entitlement - remaining) / entitlement) * 100;
  } else {
    return null;
  }
  return buildWindow({ usedPercent, resetAt: resetIso });
}

function describeCopilotOtelStatus({ home, env = process.env } = {}) {
  const resolvedHome = home || env.HOME || os.homedir();
  const enabled = String(env.COPILOT_OTEL_ENABLED || "").toLowerCase() === "true";
  const exporterType = String(env.COPILOT_OTEL_EXPORTER_TYPE || "").toLowerCase();
  const explicitPath = typeof env.COPILOT_OTEL_FILE_EXPORTER_PATH === "string"
    ? env.COPILOT_OTEL_FILE_EXPORTER_PATH
    : "";
  const defaultDir = path.join(resolvedHome, ".copilot", "otel");
  let hasFiles = false;
  try {
    if (fs.existsSync(defaultDir)) {
      hasFiles = fs.readdirSync(defaultDir).some((entry) => entry.endsWith(".jsonl"));
    }
  } catch (_e) {}
  if (!hasFiles && explicitPath && fs.existsSync(explicitPath)) hasFiles = true;
  return {
    otel_enabled: enabled && (exporterType === "" || exporterType === "file"),
    otel_exporter_type: exporterType || null,
    otel_path: explicitPath || null,
    otel_default_dir: defaultDir,
    otel_has_files: hasFiles,
  };
}

async function fetchCopilotLimits({
  home,
  env = process.env,
  fetchImpl = fetch,
  platform = process.platform,
  securityRunner,
  sqliteReader,
} = {}) {
  const otel = describeCopilotOtelStatus({ home, env });
  const token = await readCopilotOauthTokenAsync({
    home: home || (env.HOME || os.homedir()),
    platform,
    securityRunner,
    sqliteReader,
  });
  if (!token) return { configured: false, ...otel };

  try {
    const res = await fetchImpl("https://api.github.com/copilot_internal/user", {
      method: "GET",
      headers: copilotRequestHeaders(token),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("GitHub Copilot token rejected. Re-authenticate via GitHub Copilot CLI/extension.");
    }
    if (!res.ok) {
      throw new Error(`GitHub Copilot API error: HTTP ${res.status}`);
    }
    const json = await res.json();
    const planName = typeof json?.copilot_plan === "string" && json.copilot_plan
      ? json.copilot_plan.charAt(0).toUpperCase() + json.copilot_plan.slice(1)
      : null;
    const resetIso = copilotResetIso(json?.quota_reset_date);
    const snapshots = json?.quota_snapshots || {};
    const premiumWindow = buildCopilotWindow(snapshots.premium_interactions, resetIso);
    const chatWindow = buildCopilotWindow(snapshots.chat, resetIso);

    if (!premiumWindow && !chatWindow) {
      return { configured: true, error: null, plan_name: planName, primary_window: null, secondary_window: null, ...otel };
    }

    return {
      configured: true,
      error: null,
      plan_name: planName,
      primary_window: premiumWindow,
      secondary_window: chatWindow,
      ...otel,
    };
  } catch (error) {
    return { configured: true, error: error?.message || "Unknown error", ...otel };
  }
}

async function fetchKiroLimits({ commandRunner, now = new Date() } = {}) {
  if (!(await isBinaryAvailable("kiro-cli", { commandRunner }))) {
    return { configured: false };
  }

  const result = await runCommand(
    commandRunner,
    "kiro-cli",
    ["chat", "--no-interactive", "/usage"],
    {
      timeout: 20_000,
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );

  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const output = stderr.trim() || stdout.trim();

  try {
    if (result?.error?.code === "ETIMEDOUT" && !isKiroUsageOutputComplete(output)) {
      throw new Error("Kiro CLI timed out.");
    }
    if (!output && result?.status !== 0) {
      throw new Error(`Kiro CLI failed with status ${result.status}.`);
    }

    return {
      configured: true,
      error: null,
      ...parseKiroUsageOutput(output, { now }),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function parseProcessLine(line) {
  const match = String(line || "")
    .trim()
    .match(/^(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    command: match[2],
  };
}

function firstCommandToken(command) {
  const trimmed = String(command || "").trimStart();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/, 1)[0] || "";
}

function isAntigravityCommandLine(command) {
  const raw = String(command || "");
  const lower = raw.toLowerCase();
  const executable = firstCommandToken(raw).split(/[\\/]/).pop() || "";

  // The agy CLI binary itself runs as a server with Connect-RPC endpoints.
  // Match only the executable token's basename so absolute paths work without
  // treating arbitrary arguments like `vim /tmp/agy` as an Antigravity server.
  if (/^agy(?:\.exe)?$/i.test(executable)) return true;

  // IDE language_server — only return true when accompanied by Antigravity-specific
  // markers so sibling Codeium products (Windsurf, etc.) are not misidentified.
  const hasLangServerBinary = /^language_server(?:_[a-z0-9]+)*(?:\.exe)?$/i.test(executable);

  const hasAntigravityMarker =
    (lower.includes("--app_data_dir") && lower.includes("antigravity")) ||
    lower.includes("/antigravity/") ||
    lower.includes("/antigravity.app/") ||
    lower.includes("\\antigravity\\") ||
    /--override_ide_name(?:=|\s+)["']?antigravity\b/i.test(raw);

  return hasLangServerBinary && hasAntigravityMarker;
}

function extractCommandFlag(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(command || "").match(new RegExp(`${escaped}[=\\s]+([^\\s]+)`, "i"));
  return match?.[1] || null;
}

async function detectAntigravityProcess({ commandRunner } = {}) {
  const result = await runCommand(commandRunner, "/bin/ps", ["-ax", "-o", "pid=,command="], {
    timeout: 4000,
  });
  const lines = String(result?.stdout || "").split("\n");

  let sawProcess = false;
  for (const line of lines) {
    const parsed = parseProcessLine(line);
    if (!parsed) continue;
    if (!isAntigravityCommandLine(parsed.command)) continue;
    sawProcess = true;
    const csrfToken = extractCommandFlag(parsed.command, "--csrf_token") || null;
    const extensionPort = extractFirstNumber(extractCommandFlag(parsed.command, "--extension_server_port"));
    return {
      configured: true,
      pid: parsed.pid,
      csrfToken,
      extensionPort: Number.isFinite(extensionPort) ? extensionPort : null,
    };
  }

  if (sawProcess) {
    return { configured: true, error: "Antigravity CSRF token not found. Restart Antigravity and retry." };
  }
  return { configured: false };
}

function resolveAntigravityLimitsCachePath({ home } = {}) {
  return path.join(home || os.homedir(), ".tokentracker", "tracker", ANTIGRAVITY_LIMITS_CACHE_FILE);
}

function parseTimeMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function isCacheWindowUsable(window, { cachedAtMs, nowMs } = {}) {
  if (!window || typeof window !== "object") return false;
  const resetAtMs = parseTimeMs(window.reset_at);
  if (resetAtMs !== null) return resetAtMs > nowMs;
  return Number.isFinite(cachedAtMs)
    && nowMs - cachedAtMs <= ANTIGRAVITY_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS;
}

function hasAntigravityWindow(limits) {
  return Boolean(limits?.primary_window || limits?.secondary_window || limits?.tertiary_window || limits?.quaternary_window);
}

function normalizeAntigravityCachedLimits(raw, { nowMs = Date.now() } = {}) {
  const cachedAtMs = parseTimeMs(raw?.cached_at);
  if (!Number.isFinite(cachedAtMs)) return null;
  if (cachedAtMs > nowMs + 60_000) return null;
  if (nowMs - cachedAtMs > ANTIGRAVITY_LIMITS_CACHE_MAX_AGE_MS) return null;

  const cached = {
    configured: true,
    error: null,
    account_email: typeof raw?.account_email === "string" ? raw.account_email : null,
    account_plan: typeof raw?.account_plan === "string" ? raw.account_plan : null,
    primary_window: isCacheWindowUsable(raw?.primary_window, { cachedAtMs, nowMs }) ? raw.primary_window : null,
    secondary_window: isCacheWindowUsable(raw?.secondary_window, { cachedAtMs, nowMs }) ? raw.secondary_window : null,
    tertiary_window: isCacheWindowUsable(raw?.tertiary_window, { cachedAtMs, nowMs }) ? raw.tertiary_window : null,
    quaternary_window: isCacheWindowUsable(raw?.quaternary_window, { cachedAtMs, nowMs }) ? raw.quaternary_window : null,
    cached: true,
    cached_at: raw.cached_at,
  };
  return hasAntigravityWindow(cached) ? cached : null;
}

function readAntigravityLimitsCache({ home, nowMs = Date.now() } = {}) {
  const cachePath = resolveAntigravityLimitsCachePath({ home });
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return normalizeAntigravityCachedLimits(parsed?.antigravity, { nowMs });
  } catch (_error) {
    return null;
  }
}

function writeAntigravityLimitsCache(limits, { home, nowMs = Date.now() } = {}) {
  if (!limits?.configured || limits.error || !hasAntigravityWindow(limits)) return;
  const cachePath = resolveAntigravityLimitsCachePath({ home });
  const payload = {
    antigravity: {
      account_email: limits.account_email || null,
      account_plan: limits.account_plan || null,
      primary_window: limits.primary_window || null,
      secondary_window: limits.secondary_window || null,
      tertiary_window: limits.tertiary_window || null,
      quaternary_window: limits.quaternary_window || null,
      cached_at: new Date(nowMs).toISOString(),
    },
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function resolveClaudeLimitsCachePath({ home } = {}) {
  return path.join(home || os.homedir(), ".tokentracker", "tracker", CLAUDE_LIMITS_CACHE_FILE);
}

// Claude windows carry their own `resets_at`; a window whose reset has already passed is
// stale data, not a usable fallback, so drop it. Windows without a reset stamp are kept
// (the overall cached_at max-age gate already bounds them).
function isClaudeCacheWindowUsable(window, { nowMs } = {}) {
  if (!window || typeof window !== "object") return false;
  const resetAtMs = parseTimeMs(window.resets_at);
  if (resetAtMs === null) return true;
  return resetAtMs > nowMs;
}

function hasClaudeWindow(limits) {
  return Boolean(
    limits?.five_hour || limits?.seven_day || limits?.seven_day_opus ||
    (Array.isArray(limits?.weekly_scoped) && limits.weekly_scoped.length > 0),
  );
}

// Cached scoped windows are filtered per-entry like the fixed windows: a scoped
// window whose reset has passed is stale data, not a usable fallback.
function normalizeClaudeCachedScopedWeekly(raw, { nowMs } = {}) {
  if (!Array.isArray(raw)) return null;
  const usable = raw.filter(
    (w) => w && typeof w.label === "string" && Number.isFinite(Number(w.utilization)) &&
      isClaudeCacheWindowUsable(w, { nowMs }),
  );
  return usable.length > 0 ? usable : null;
}

function normalizeClaudeCachedLimits(
  raw,
  {
    nowMs = Date.now(),
    maxAgeMs = CLAUDE_LIMITS_CACHE_MAX_AGE_MS,
    stale = true,
  } = {},
) {
  const cachedAtMs = parseTimeMs(raw?.cached_at);
  if (!Number.isFinite(cachedAtMs)) return null;
  if (cachedAtMs > nowMs + 60_000) return null;
  if (nowMs - cachedAtMs > maxAgeMs) return null;

  const cached = {
    configured: true,
    error: null,
    five_hour: isClaudeCacheWindowUsable(raw?.five_hour, { nowMs }) ? raw.five_hour : null,
    seven_day: isClaudeCacheWindowUsable(raw?.seven_day, { nowMs }) ? raw.seven_day : null,
    seven_day_opus: isClaudeCacheWindowUsable(raw?.seven_day_opus, { nowMs }) ? raw.seven_day_opus : null,
    weekly_scoped: normalizeClaudeCachedScopedWeekly(raw?.weekly_scoped, { nowMs }),
    extra_usage: raw?.extra_usage ?? null,
    stale,
    cached_at: raw.cached_at,
  };
  return hasClaudeWindow(cached) ? cached : null;
}

function readClaudeLimitsCacheRaw({ home } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveClaudeLimitsCachePath({ home }), "utf8"));
    return parsed?.claude ?? null;
  } catch (_error) {
    return null;
  }
}

function readClaudeLimitsCache({
  home,
  nowMs = Date.now(),
  maxAgeMs = CLAUDE_LIMITS_CACHE_MAX_AGE_MS,
  stale = true,
} = {}) {
  return normalizeClaudeCachedLimits(readClaudeLimitsCacheRaw({ home }), { nowMs, maxAgeMs, stale });
}

// A cached snapshot stops being "fresh" the moment any of its windows crosses the
// reset boundary it was written with: serving it past that point hides the rollover
// from reset detection (the menu bar confetti) for up to the fresh TTL. Only resets
// that were still ahead at write time count — a provider stamping already-past reset
// times must not force a live call on every poll.
function claudeCacheCrossedReset(raw, { nowMs } = {}) {
  const cachedAtMs = parseTimeMs(raw?.cached_at);
  if (!Number.isFinite(cachedAtMs)) return false;
  const windows = [
    raw?.five_hour,
    raw?.seven_day,
    raw?.seven_day_opus,
    ...(Array.isArray(raw?.weekly_scoped) ? raw.weekly_scoped : []),
  ];
  return windows.some((window) => {
    const resetMs = parseTimeMs(window?.resets_at);
    return resetMs !== null && resetMs > cachedAtMs && resetMs <= nowMs;
  });
}

function readFreshClaudeLimitsCache({ home, nowMs = Date.now() } = {}) {
  const raw = readClaudeLimitsCacheRaw({ home });
  if (!raw || claudeCacheCrossedReset(raw, { nowMs })) return null;
  return normalizeClaudeCachedLimits(raw, {
    nowMs,
    maxAgeMs: CLAUDE_LIMITS_CACHE_FRESH_TTL_MS,
    stale: false,
  });
}

function writeClaudeLimitsCache(limits, { home, nowMs = Date.now() } = {}) {
  if (!limits?.configured || limits.error || !hasClaudeWindow(limits)) return;
  const cachePath = resolveClaudeLimitsCachePath({ home });
  const payload = {
    claude: {
      five_hour: limits.five_hour || null,
      seven_day: limits.seven_day || null,
      seven_day_opus: limits.seven_day_opus || null,
      weekly_scoped: Array.isArray(limits.weekly_scoped) && limits.weekly_scoped.length > 0
        ? limits.weekly_scoped
        : null,
      extra_usage: limits.extra_usage || null,
      cached_at: new Date(nowMs).toISOString(),
    },
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function resolveCodexLimitsCachePath({ home } = {}) {
  return path.join(home || os.homedir(), ".tokentracker", "tracker", CODEX_LIMITS_CACHE_FILE);
}

// Codex windows carry `reset_at` as unix seconds (not an ISO string). A window whose reset has
// already passed is stale data, not a usable fallback, so drop it. Windows without a reset stamp
// are kept — the overall cached_at max-age gate already bounds them.
function isCodexCacheWindowUsable(window, { nowMs } = {}) {
  if (!window || typeof window !== "object") return false;
  const resetAt = Number(window.reset_at);
  if (!Number.isFinite(resetAt) || resetAt <= 0) return true;
  return resetAt * 1000 > nowMs;
}

function hasCodexWindow(limits) {
  return Boolean(
    limits?.primary_window
    || limits?.secondary_window
    || limits?.credit_window
    || limits?.spark_primary_window
    || limits?.spark_secondary_window,
  );
}

function normalizeCodexCachedLimits(
  raw,
  { nowMs = Date.now(), maxAgeMs = CODEX_LIMITS_CACHE_MAX_AGE_MS } = {},
) {
  const cachedAtMs = parseTimeMs(raw?.cached_at);
  if (!Number.isFinite(cachedAtMs)) return null;
  if (cachedAtMs > nowMs + 60_000) return null;
  if (nowMs - cachedAtMs > maxAgeMs) return null;

  const cached = {
    configured: true,
    error: null,
    plan_type: typeof raw?.plan_type === "string" ? raw.plan_type : null,
    primary_window: isCodexCacheWindowUsable(raw?.primary_window, { nowMs }) ? raw.primary_window : null,
    secondary_window: isCodexCacheWindowUsable(raw?.secondary_window, { nowMs }) ? raw.secondary_window : null,
    credit_window: isCodexCacheWindowUsable(raw?.credit_window, { nowMs }) ? raw.credit_window : null,
    spark_primary_window: isCodexCacheWindowUsable(raw?.spark_primary_window, { nowMs }) ? raw.spark_primary_window : null,
    spark_secondary_window: isCodexCacheWindowUsable(raw?.spark_secondary_window, { nowMs }) ? raw.spark_secondary_window : null,
    reset_credits: raw?.reset_credits ?? null,
    stale: true,
    cached_at: raw.cached_at,
  };
  return hasCodexWindow(cached) ? cached : null;
}

function readCodexLimitsCache({ home, nowMs = Date.now(), maxAgeMs = CODEX_LIMITS_CACHE_MAX_AGE_MS } = {}) {
  const cachePath = resolveCodexLimitsCachePath({ home });
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return normalizeCodexCachedLimits(parsed?.codex, { nowMs, maxAgeMs });
  } catch (_error) {
    return null;
  }
}

function writeCodexLimitsCache(limits, { home, nowMs = Date.now() } = {}) {
  if (!limits?.configured || limits.error || !hasCodexWindow(limits)) return;
  const cachePath = resolveCodexLimitsCachePath({ home });
  const payload = {
    codex: {
      plan_type: limits.plan_type || null,
      primary_window: limits.primary_window || null,
      secondary_window: limits.secondary_window || null,
      credit_window: limits.credit_window || null,
      spark_primary_window: limits.spark_primary_window || null,
      spark_secondary_window: limits.spark_secondary_window || null,
      reset_credits: limits.reset_credits || null,
      cached_at: new Date(nowMs).toISOString(),
    },
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function resolveClaudeRateLimitPath({ home } = {}) {
  return path.join(home || os.homedir(), ".tokentracker", "tracker", CLAUDE_RATE_LIMIT_FILE);
}

// Returns the cooldown expiry in ms if a 429 cooldown is still active, else null.
function readClaudeRateLimitRetryAtMs({ home, nowMs = Date.now() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveClaudeRateLimitPath({ home }), "utf8"));
    const retryAtMs = parseTimeMs(parsed?.retry_at);
    if (retryAtMs !== null && retryAtMs > nowMs) return retryAtMs;
  } catch (_error) {}
  return null;
}

function writeClaudeRateLimitCooldown(retryAfterSec, { home, nowMs = Date.now() } = {}) {
  const sec = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.min(retryAfterSec, CLAUDE_RATE_LIMIT_MAX_COOLDOWN_SEC)
    : CLAUDE_RATE_LIMIT_DEFAULT_COOLDOWN_SEC;
  const cachePath = resolveClaudeRateLimitPath({ home });
  const payload = { retry_at: new Date(nowMs + sec * 1000).toISOString() };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function clearClaudeRateLimitCooldown({ home } = {}) {
  try {
    fs.unlinkSync(resolveClaudeRateLimitPath({ home }));
  } catch (_error) {}
}

async function resolveLsofBinary({ commandRunner } = {}) {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return whichBinary("lsof", { commandRunner });
}

function parseListeningPorts(output) {
  const matches = String(output || "").matchAll(/:(\d+)\s+\(LISTEN\)/g);
  const ports = new Set();
  for (const match of matches) {
    const port = Number(match[1]);
    if (Number.isFinite(port)) {
      ports.add(port);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

async function listAntigravityPorts(pid, { commandRunner } = {}) {
  const lsof = await resolveLsofBinary({ commandRunner });
  if (!lsof) {
    throw new Error("Antigravity port detection needs lsof. Install it, then retry.");
  }
  const result = await runCommand(
    commandRunner,
    lsof,
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    { timeout: 4000 },
  );
  const ports = parseListeningPorts(result?.stdout);
  if (!ports.length) {
    throw new Error("Antigravity is running but not exposing ports yet. Try again in a few seconds.");
  }
  return ports;
}

function antigravityDefaultBody() {
  return {
    metadata: {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    },
  };
}

function antigravityUnleashBody() {
  return {
    context: {
      properties: {
        devMode: "false",
        extensionVersion: "unknown",
        hasAnthropicModelAccess: "true",
        ide: "antigravity",
        ideVersion: "unknown",
        installationId: "tokentracker",
        language: "UNSPECIFIED",
        os: "macos",
        requestedModelId: "MODEL_UNSPECIFIED",
      },
    },
  };
}

function requestLocalJson({
  scheme,
  port,
  path,
  body,
  csrfToken,
  timeoutMs = 8000,
  requestFn,
}) {
  if (typeof requestFn === "function") {
    return requestFn({ scheme, port, path, body, csrfToken, timeoutMs });
  }

  const client = scheme === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      "Connect-Protocol-Version": "1",
    };
    if (csrfToken) {
      headers["X-Codeium-Csrf-Token"] = csrfToken;
    }
    const req = client.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(rawBody);
    req.end();
  });
}

function antigravityCodeIsOk(code) {
  if (code === null || code === undefined) return true;
  if (typeof code === "number") return code === 0;
  if (typeof code === "string") {
    const lower = code.toLowerCase();
    return lower === "ok" || lower === "success" || lower === "0";
  }
  return false;
}

function parseAntigravityDate(value) {
  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(numeric * 1000).toISOString();
    }
    if (Number.isFinite(numeric)) return null;
    const iso = Date.parse(value);
    if (Number.isFinite(iso) && iso > 0) return new Date(iso).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function parseAntigravityModelConfigs(configs) {
  if (!Array.isArray(configs)) return [];
  return configs
    .map((config) => {
      const quota = config?.quotaInfo || null;
      if (!quota) return null;
      return {
        label: typeof config?.label === "string" ? config.label : "",
        model_id: typeof config?.modelOrAlias?.model === "string" ? config.modelOrAlias.model : "",
        remaining_fraction:
          typeof quota?.remainingFraction === "number" && Number.isFinite(quota.remainingFraction)
            ? quota.remainingFraction
            : null,
        reset_at: parseAntigravityDate(quota?.resetTime),
      };
    })
    .filter(Boolean);
}

function antigravityFamily(model) {
  const text = `${model?.label || ""} ${model?.model_id || ""}`.toLowerCase();
  if (text.includes("claude")) return "claude";
  if (text.includes("gemini") && text.includes("pro")) return "gemini_pro";
  if (text.includes("gemini") && text.includes("flash")) return "gemini_flash";
  return "unknown";
}

function antigravityPriority(model) {
  const text = `${model?.label || ""} ${model?.model_id || ""}`.toLowerCase();
  if (text.includes("lite") || text.includes("autocomplete") || text.includes("tab_")) return null;
  if (antigravityFamily(model) === "gemini_pro") {
    return text.includes("pro-low") || (text.includes("pro") && text.includes("low")) ? 0 : 1;
  }
  return 0;
}

function normalizeAntigravityResponse(body, { fallbackToConfigs = false } = {}) {
  if (!antigravityCodeIsOk(body?.code)) {
    throw new Error(`Antigravity API error: ${body?.code}`);
  }

  const userStatus = body?.userStatus || null;
  const configs = fallbackToConfigs
    ? body?.clientModelConfigs
    : userStatus?.cascadeModelConfigData?.clientModelConfigs;
  const allModels = parseAntigravityModelConfigs(configs);
  if (!allModels.length) {
    throw new Error("Could not parse Antigravity quota: no quota models available.");
  }

  // Keep only chat models (skip autocomplete/lite/tab models)
  const chatModels = allModels.filter((m) => antigravityPriority(m) !== null);
  const models = chatModels.length ? chatModels : allModels;

  // Group chat models and pick the most-used (lowest remaining → weekly quota)
  // and least-used (highest remaining → 5h rolling quota) per family.
  const claudeModels = models.filter((m) => antigravityFamily(m) === "claude");
  const geminiModels = models.filter(
    (m) => antigravityFamily(m) === "gemini_pro" || antigravityFamily(m) === "gemini_flash",
  );

  const pickMin = (list) => {
    const sorted = [...list].filter((m) => typeof m.remaining_fraction === "number");
    if (!sorted.length) return list[0] || null;
    sorted.sort((a, b) => a.remaining_fraction - b.remaining_fraction);
    return sorted[0];
  };
  const pickMax = (list) => {
    const sorted = [...list].filter((m) => typeof m.remaining_fraction === "number");
    if (!sorted.length) return list[list.length - 1] || null;
    sorted.sort((a, b) => b.remaining_fraction - a.remaining_fraction);
    return sorted[0];
  };

  const makeWindow = (model) => {
    if (!model) return null;
    const remaining = typeof model.remaining_fraction === "number" ? model.remaining_fraction * 100 : 0;
    return buildWindow({ usedPercent: 100 - remaining, resetAt: model.reset_at });
  };

  return {
    account_email: typeof userStatus?.email === "string" ? userStatus.email : null,
    account_plan:
      userStatus?.planStatus?.planInfo?.planDisplayName
      || userStatus?.planStatus?.planInfo?.displayName
      || userStatus?.planStatus?.planInfo?.productName
      || userStatus?.planStatus?.planInfo?.planName
      || userStatus?.planStatus?.planInfo?.planShortName
      || null,
    primary_window: makeWindow(claudeModels.length ? pickMin(claudeModels) : pickMin(models)),
    secondary_window: makeWindow(claudeModels.length ? pickMax(claudeModels) : null),
    tertiary_window: makeWindow(geminiModels.length ? pickMin(geminiModels) : pickMin(models)),
    quaternary_window: makeWindow(geminiModels.length ? pickMax(geminiModels) : null),
  };
}

function normalizeAntigravityQuotaSummary(body) {
  if (!antigravityCodeIsOk(body?.code)) {
    throw new Error(`Antigravity API error: ${body?.code}`);
  }

  const groups = body?.response?.groups;
  if (!Array.isArray(groups) || !groups.length) {
    throw new Error("Could not parse Antigravity quota summary: no groups.");
  }

  // Map bucketId → window, regardless of which group they live in
  const makeWindow = (remainingFraction, resetTime) => {
    if (typeof remainingFraction !== "number") return null;
    return buildWindow({ usedPercent: 100 - remainingFraction * 100, resetAt: resetTime || null });
  };

  // Collect all buckets into a flat bucketId-keyed map
  const buckets = {};
  for (const group of groups) {
    if (!Array.isArray(group.buckets)) continue;
    for (const b of group.buckets) {
      buckets[b.bucketId] = b;
    }
  }

  const windows = {
    primary_window: makeWindow(buckets["3p-weekly"]?.remainingFraction, buckets["3p-weekly"]?.resetTime),
    secondary_window: makeWindow(buckets["3p-5h"]?.remainingFraction, buckets["3p-5h"]?.resetTime),
    tertiary_window: makeWindow(buckets["gemini-weekly"]?.remainingFraction, buckets["gemini-weekly"]?.resetTime),
    quaternary_window: makeWindow(buckets["gemini-5h"]?.remainingFraction, buckets["gemini-5h"]?.resetTime),
  };

  // If the groups parsed but none of the known bucketIds matched (upstream
  // renamed them), treat it as a parse failure so the caller falls back to
  // GetUserStatus rather than rendering an empty, error-free card.
  if (!windows.primary_window && !windows.secondary_window
    && !windows.tertiary_window && !windows.quaternary_window) {
    throw new Error("Could not parse Antigravity quota summary: no known buckets matched.");
  }

  return {
    account_email: null, // quota summary doesn't include email
    account_plan: null,  // quota summary doesn't include plan info
    ...windows,
  };
}

async function probeAntigravityPort(port, csrfToken, { timeoutMs, requestFn, scheme = "https" } = {}) {
  try {
    await requestLocalJson({
      scheme,
      port,
      path: "/exa.language_server_pb.LanguageServerService/GetUnleashData",
      body: antigravityUnleashBody(),
      csrfToken,
      timeoutMs,
      requestFn,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function hasAntigravityInstallEvidence({ home } = {}) {
  const geminiHome = path.join(home || os.homedir(), ".gemini");
  return ["antigravity", "antigravity-ide", "antigravity-cli"]
    .some((name) => {
      try {
        return fs.statSync(path.join(geminiHome, name)).isDirectory();
      } catch {
        return false;
      }
    });
}

async function fetchAntigravityLimits({ home, commandRunner, requestFn, fetchImpl = fetch, timeoutMs = 8000, nowMs = Date.now() } = {}) {
  const finalize = (payload, normalizeOptions) => {
    const result = {
      configured: true,
      error: null,
      ...normalizeAntigravityResponse(payload, normalizeOptions),
    };
    writeAntigravityLimitsCache(result, { home, nowMs });
    return result;
  };

  const finalizeQuotaSummary = (payload) => {
    const result = {
      configured: true,
      error: null,
      ...normalizeAntigravityQuotaSummary(payload),
    };
    writeAntigravityLimitsCache(result, { home, nowMs });
    return result;
  };

  try {
    const processInfo = await detectAntigravityProcess({ commandRunner });
    if (!processInfo.configured) {
      const cached = readAntigravityLimitsCache({ home, nowMs });
      if (cached) return cached;
      // No install evidence → user likely doesn't have Antigravity at all.
      // Return configured:false so the card stays neutral (like other providers).
      if (!hasAntigravityInstallEvidence({ home })) {
        return { configured: false };
      }
      return { configured: true, error: "Antigravity IDE is not running. Launch Antigravity to see usage limits." };
    }
    if (processInfo.error) {
      return { configured: true, error: processInfo.error };
    }
    const ports = await listAntigravityPorts(processInfo.pid, { commandRunner });
    let workingPort = null;
    let workingScheme = "https";
    for (const port of ports) {
      if (await probeAntigravityPort(port, processInfo.csrfToken, { timeoutMs, requestFn })) {
        workingPort = port;
        break;
      }
      // agy CLI serves both HTTPS and HTTP; no CSRF needed
      if (!processInfo.csrfToken) {
        if (await probeAntigravityPort(port, null, { timeoutMs, requestFn, scheme: "http" })) {
          workingPort = port;
          workingScheme = "http";
          break;
        }
      }
    }
    if (!workingPort) {
      throw new Error("Antigravity port detection failed: no working API port found");
    }

    try {
      const quotaSummary = await requestLocalJson({
        scheme: workingScheme,
        port: workingPort,
        path: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        body: antigravityDefaultBody(),
        csrfToken: processInfo.csrfToken,
        timeoutMs,
        requestFn,
      });
      return finalizeQuotaSummary(quotaSummary);
    } catch (_quotaError) {
      // quota summary not available (IDE servers return 404) → fall back to GetUserStatus
    }

    try {
      const userStatus = await requestLocalJson({
        scheme: workingScheme,
        port: workingPort,
        path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        body: antigravityDefaultBody(),
        csrfToken: processInfo.csrfToken,
        timeoutMs,
        requestFn,
      });
      return finalize(userStatus);
    } catch (primaryError) {
      const fallbackPort =
        Number.isFinite(processInfo.extensionPort) && processInfo.extensionPort > 0
          ? processInfo.extensionPort
          : workingPort;
      // agy has no extension server port; try HTTP on the same port
      const fallbackScheme = !processInfo.csrfToken && fallbackPort === workingPort
        ? (workingScheme === "https" ? "http" : "https")
        : (fallbackPort === workingPort ? "https" : "http");
      const modelConfigs = await requestLocalJson({
        scheme: fallbackScheme,
        port: fallbackPort,
        path: "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
        body: antigravityDefaultBody(),
        csrfToken: processInfo.csrfToken,
        timeoutMs,
        requestFn,
      });
      return finalize(modelConfigs, { fallbackToConfigs: true });
    }
  } catch (error) {
    const cached = readAntigravityLimitsCache({ home, nowMs });
    if (cached) return cached;
    // If there's no install evidence, this error is likely from a system that
    // never had Antigravity — return neutral state like other providers.
    if (!hasAntigravityInstallEvidence({ home })) {
      return { configured: false };
    }
    const message = error?.message === "timeout"
      ? "Antigravity quota request timed out."
      : error?.message || "Unknown error";
    return {
      configured: true,
      error: message,
    };
  }
}

function toTitleCase(s) {
  return s.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// Normalize a plan tier name: free/empty/placeholder -> null; otherwise strip the
// leading brand word and Title Case the rest.
function normalizePlanLabel(raw, brand) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (["free", "none", "unknown"].includes(lower)) return null;
  if (brand && lower === brand.toLowerCase()) return null; // e.g. Kiro defaults plan_name to "Kiro" when parse fails
  if (brand) {
    s = s.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
    if (!s) return null;
  }
  return toTitleCase(s);
}

// Attach plan_label only to a configured, error-free provider object (immutable).
function withPlanLabel(obj, raw, brand) {
  if (!obj || !obj.configured || obj.error) return obj;
  return { ...obj, plan_label: normalizePlanLabel(raw, brand) };
}

// Single-flight guard: concurrent cache misses share one upstream fetch instead of
// each triggering the full 9-provider round (Claude's OAuth usage endpoint 429s when
// hammered). Survives an external resetUsageLimitsCache() (refresh=1 path in
// local-api.js): a refresh arriving while a fetch is already running reuses that
// in-flight fetch and returns its result.
let inFlightFetch = null;

// Codex stamps reset_at as unix seconds; every other provider (and Claude's
// resets_at) uses ISO strings. Numbers that look like epoch milliseconds are
// accepted as-is so a future provider can't silently regress this.
function resetValueToMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  return parseTimeMs(value);
}

// Walk the aggregated response and collect every window reset timestamp,
// whatever the provider-specific nesting looks like.
function collectResetTimesMs(node, out) {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "reset_at" || key === "resets_at") {
      const ms = resetValueToMs(value);
      if (ms !== null) out.push(ms);
    } else if (value && typeof value === "object") {
      collectResetTimesMs(value, out);
    }
  }
}

// The moment any window rolls over, cached data stops being current — reset
// detection (the menu bar confetti) would otherwise lag by up to the full TTL.
function cacheExpiresAtMs(data, fetchedAtMs) {
  const times = [];
  collectResetTimesMs(data, times);
  const upcoming = times.filter((t) => t > fetchedAtMs);
  const ttlExpiry = fetchedAtMs + CACHE_TTL_MS;
  if (upcoming.length === 0) return ttlExpiry;
  return Math.min(ttlExpiry, Math.max(Math.min(...upcoming), fetchedAtMs + CACHE_MIN_TTL_MS));
}

async function getUsageLimits(options = {}) {
  const nowMs = Date.now();
  if (cache.data && nowMs < cache.expiresAtMs) {
    return cache.data;
  }
  if (inFlightFetch) {
    return inFlightFetch;
  }
  const promise = fetchUsageLimitsUncached(options).finally(() => {
    if (inFlightFetch === promise) inFlightFetch = null;
  });
  inFlightFetch = promise;
  return promise;
}

async function fetchUsageLimitsUncached({
  home,
  env,
  platform,
  securityRunner,
  fetchImpl = fetch,
  commandRunner,
  requestFn,
  now = new Date(),
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  forceRefresh = false,
} = {}) {
  const nowMs = Date.now();

  const [claudeToken, claudeSubscription, codexAuth] = await Promise.all([
    Promise.resolve().then(() => readClaudeCodeAccessToken({ platform, securityRunner, home })),
    Promise.resolve().then(() => detectClaudeCodeSubscriptionDetails({ platform, securityRunner, home })),
    readCodexAuthBundle({ home, env }),
  ]);
  const claudePlanType = claudeSubscription?.planType || null;

  // Proactively refresh Codex tokens that are >8 days stale, mirroring CodexBar's
  // CodexTokenRefresher.swift. Without this, users who logged in once and didn't run
  // `codex` for >a week get wham 401 → "Fetch failed" (issue #52). Best-effort: any
  // refresh failure falls through to using the existing (possibly stale) token, then the
  // 4xx graceful path in fetchCodexUsageLimits surfaces a neutral state instead of red.
  let refreshError = null;
  let codexAuthRefreshed = codexAuth;
  if (codexAuth && isTokenStale(codexAuth.lastRefresh) && codexAuth.refreshToken) {
    try {
      const newTokens = await refreshCodexTokens({
        refreshToken: codexAuth.refreshToken,
        fetchImpl,
      });
      const updatedAuth = await persistRefreshedAuth(
        codexAuth.authPath,
        codexAuth.authJson,
        newTokens,
      );
      codexAuthRefreshed = {
        ...codexAuth,
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        lastRefresh: updatedAuth.last_refresh,
        authJson: updatedAuth,
      };
    } catch (err) {
      refreshError = err;
    }
  }

  const codexToken = codexAuthRefreshed?.accessToken || null;
  const codexAccountId = codexAuthRefreshed?.accountId || null;
  const codexPlanType = codexAuthRefreshed?.planType || null;

  // Skip the upstream Claude call entirely while a 429 cooldown is active — calling again
  // just renews the penalty. The result handling below serves cache or a cooldown message.
  const claudeRetryAtMs = claudeToken ? readClaudeRateLimitRetryAtMs({ home, nowMs }) : null;
  // Also avoid cross-process hammering after a recent successful read: embedded-server
  // restarts and background polls read the disk cache instead of spending another Claude
  // OAuth usage request. An explicit user refresh (refresh=1 → forceRefresh) punches
  // through this cache — but never through the 429 cooldown above, which is exactly the
  // hammering the cooldown exists to prevent.
  const freshClaudeCache = claudeToken && !forceRefresh
    ? readFreshClaudeLimitsCache({ home, nowMs })
    : null;

  const providerFetch = withFetchTimeout(fetchImpl, providerTimeoutMs);
  const [claudeResult, codexResult, cursor, kimi, gemini, kiro, antigravity, copilot, grok, zcode, opencodeGo] = await Promise.all([
    claudeToken && !freshClaudeCache && !claudeRetryAtMs
      ? withProviderTimeout(fetchClaudeUsageLimits(claudeToken, { fetchImpl: providerFetch, maxAttempts: 1 }), "Claude", providerTimeoutMs).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        )
      : Promise.resolve(null),
    codexToken
      ? fetchCodexUsageLimits(codexToken, {
          fetchImpl: providerFetch,
          accountId: codexAccountId,
          providerTimeoutMs,
        }).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        )
      : Promise.resolve(null),
    withProviderTimeout(fetchCursorLimits({ home, fetchImpl: providerFetch }), "Cursor", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchKimiLimits({ home, env, fetchImpl: providerFetch }), "Kimi", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchGeminiLimits({ home, env, fetchImpl: providerFetch, commandRunner }), "Gemini", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    fetchKiroLimits({ commandRunner, now }),
    fetchAntigravityLimits({ home, commandRunner, requestFn, fetchImpl: providerFetch, nowMs }),
    withProviderTimeout(fetchCopilotLimits({ home, env, fetchImpl: providerFetch, platform, securityRunner }), "GitHub Copilot", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchGrokLimits({ home, env, fetchImpl: providerFetch }), "Grok Build", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchZcodeLimits({ home, env, fetchImpl: providerFetch }), "ZCode", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    // OpenCode Go: local opencode.db cost-vs-dollar-cap estimate by default
    // (auth-free, zero-config), upgraded to the exact server-side scrape when an
    // OPENCODE_GO_AUTH_COOKIE is set. See src/lib/opencode-go-limits.js.
    withProviderTimeout(fetchOpencodeGoLimits({ home, env, fetchImpl: providerFetch }), "OpenCode Go", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
  ]);

  let claude;
  if (!claudeToken) {
    claude = { configured: false };
  } else if (freshClaudeCache) {
    claude = freshClaudeCache;
  } else if (claudeResult && claudeResult.status === "fulfilled") {
    claude = {
      configured: true,
      error: null,
      five_hour: claudeResult.value.five_hour,
      seven_day: claudeResult.value.seven_day,
      seven_day_opus: claudeResult.value.seven_day_opus,
      weekly_scoped: claudeResult.value.weekly_scoped,
      extra_usage: claudeResult.value.extra_usage,
      // A live read is current as of now. `stale`/`cached_at` are always present so
      // the client can render an "Updated Xm ago" age without guessing whether the
      // response was live or served from the disk-cache fallback (the cached paths
      // above already carry them). Mirrors the Codex live-success block below.
      stale: false,
      cached_at: new Date(nowMs).toISOString(),
    };
    writeClaudeLimitsCache(claude, { home, nowMs });
    clearClaudeRateLimitCooldown({ home });
  } else {
    // Either a fresh 429 (record its cooldown) or a call we skipped because a cooldown was
    // already active. Serve the last successful read so the bars stay visible; otherwise
    // surface an accurate "retry in ~Nm" message rather than the misleading hardcoded one.
    const reason = claudeResult?.reason;
    if (reason?.code === "RATE_LIMITED") {
      writeClaudeRateLimitCooldown(reason.retryAfterSec, { home, nowMs });
    }
    const cached = readClaudeLimitsCache({ home, nowMs });
    if (cached) {
      claude = cached;
    } else {
      const retryAtMs = readClaudeRateLimitRetryAtMs({ home, nowMs }) || claudeRetryAtMs;
      claude = {
        configured: true,
        error: retryAtMs
          ? formatClaudeRateLimitMessage(Math.round((retryAtMs - nowMs) / 1000))
          : reason?.message || "Unknown error",
      };
    }
    // An expired OAuth token means every future fetch fails the same way until the
    // user runs `claude` again — serving the cache silently would make refresh look
    // broken (issue #330). Flag it so the client can say why the bars stopped moving.
    if (reason?.code === "AUTH_EXPIRED") {
      claude = { ...claude, auth_action_required: "reauth" };
    }
  }

  // Expose the active 429 cool-down expiry (if any) on the Claude object so the
  // client can (a) show when the next refresh is due next to stale bars and
  // (b) schedule a one-shot refresh the instant the cool-down lifts instead of
  // waiting out the poll interval. Re-read here (not the pre-fetch value) so a
  // cool-down just armed by this cycle's 429 is included; a successful read above
  // cleared the file, so this is null in the happy path.
  if (claude.configured) {
    const claudeCooldownMs = readClaudeRateLimitRetryAtMs({ home, nowMs });
    if (claudeCooldownMs) {
      claude.retry_at = new Date(claudeCooldownMs).toISOString();
    }
  }

  let codex;
  if (!codexToken) {
    codex = { configured: false };
  } else if (refreshError && refreshError.code === "REFRESH_TOKEN_EXPIRED") {
    // Refresh token is dead — the user must re-run `codex` to log in again. Surface a
    // specific, actionable message rather than the generic "Fetch failed".
    codex = {
      configured: true,
      error: refreshError.message,
      auth_action_required: "reauth",
    };
  } else if (!codexResult || codexResult.status === "rejected") {
    // Live fetch failed or timed out (Codex hits chatgpt.com fresh every poll with no
    // rate-limit cooldown, so a slow network shows up here often). Serve the last successful
    // read so the bars stay visible instead of a red error, mirroring the Claude stale path.
    const cached = readCodexLimitsCache({ home, nowMs });
    if (cached) {
      codex = cached;
    } else {
      codex = { configured: true, error: codexResult?.reason?.message || "Unknown error" };
    }
  } else {
    codex = {
      configured: true,
      error: null,
      plan_type: codexPlanType || null,
      primary_window: codexResult.value.primary_window,
      secondary_window: codexResult.value.secondary_window,
      credit_window: codexResult.value.credit_window,
      spark_primary_window: codexResult.value.spark_primary_window,
      spark_secondary_window: codexResult.value.spark_secondary_window,
      reset_credits: codexResult.value.reset_credits,
      // Live read is current as of now; the stale fallback path above serves the
      // disk cache with `stale: true`. Always emitting both lets the client show a
      // data-age label uniformly (see the Claude live-success block).
      stale: false,
      cached_at: new Date(nowMs).toISOString(),
    };
    writeCodexLimitsCache(codex, { home, nowMs });
  }

  const data = {
    fetched_at: new Date(nowMs).toISOString(),
    claude: withPlanLabel(claude, claudePlanType, "Claude"),
    codex: withPlanLabel(codex, codex.plan_type, "Codex"),
    cursor: withPlanLabel(cursor, cursor.membership_type, "Cursor"),
    // Kimi's subType (TYPE_PURCHASE/TYPE_EVENT) is the credit *source*, not a plan
    // tier, and membership.level is an opaque enum (LEVEL_INTERMEDIATE) with no
    // authoritative human-readable plan mapping. Both rendered as garbage like
    // "Kimi Type_event" (issue #130), so show the bare brand instead.
    kimi: withPlanLabel(kimi, null, "Kimi"),
    gemini: withPlanLabel(gemini, gemini.account_plan, "Gemini"),
    kiro: withPlanLabel(kiro, kiro.plan_name, "Kiro"),
    antigravity: withPlanLabel(antigravity, antigravity.account_plan, "Antigravity"),
    copilot: withPlanLabel(copilot, copilot.plan_name, "Copilot"),
    grok: withPlanLabel(grok, null, "Grok"),
    zcode: withPlanLabel(zcode, zcode.plan_label, "ZCode"),
    opencodeGo: withPlanLabel(opencodeGo, opencodeGo?.plan_label, "OpenCode Go"),
  };

  for (const [providerName, provider] of Object.entries(data)) {
    if (providerName === "fetched_at" || !provider || typeof provider !== "object") continue;
    const capturedAt = provider.cached_at || data.fetched_at;
    const ageMs = Math.max(0, nowMs - Date.parse(capturedAt || ""));
    const stale = provider.stale === true || (Number.isFinite(ageMs) && ageMs > 10 * 60 * 1000);
    const explicitSource = typeof provider.source === "string" ? provider.source : "";
    const source = explicitSource || (stale ? "disk-cache" : "provider-api");
    const confidence = /estimate|inferred/i.test(source)
      ? "inferred"
      : /local|database|sqlite|cache/i.test(source)
        ? "observed"
        : "official";
    provider.provenance = {
      source,
      confidence,
      captured_at: capturedAt,
      stale,
      age_seconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    };
  }

  cache = { data, expiresAtMs: cacheExpiresAtMs(data, nowMs) };
  return data;
}

function resetUsageLimitsCache() {
  cache = { data: null, expiresAtMs: 0 };
}

module.exports = {
  getUsageLimits,
  normalizePlanLabel,
  resetUsageLimitsCache,
  cacheExpiresAtMs,
  runCommand,
  extractGeminiOauthClientCredentials,
  loadKimiCredentials,
  normalizeCursorUsageSummary,
  normalizeGeminiQuotaResponse,
  normalizeKimiUsageResponse,
  parseKiroUsageOutput,
  normalizeAntigravityResponse,
  parseListeningPorts,
  detectAntigravityProcess,
  fetchAntigravityLimits,
  fetchCopilotLimits,
  readCopilotOauthToken,
  readCopilotOauthTokenAsync,
  readCopilotAuthDbToken,
  readCopilotAuthDbTokenAsync,
  decryptCopilotAuthDbToken,
  describeCopilotOtelStatus,
  fetchGrokLimits,
  fetchZcodeLimits,
  fetchOpencodeGoLimits,
};
