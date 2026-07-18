const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";

function resolveGrokHome({ home, env = process.env } = {}) {
  if (typeof env.TOKENTRACKER_GROK_HOME === "string" && env.TOKENTRACKER_GROK_HOME.trim()) {
    return path.resolve(env.TOKENTRACKER_GROK_HOME.trim());
  }
  if (typeof env.GROK_HOME === "string" && env.GROK_HOME.trim()) {
    return path.resolve(env.GROK_HOME.trim());
  }
  return path.join(home || os.homedir(), ".grok");
}

function resolveGrokBillingBaseUrl(env = process.env) {
  const explicit =
    typeof env.GROK_CLI_CHAT_PROXY_BASE_URL === "string"
      ? env.GROK_CLI_CHAT_PROXY_BASE_URL.trim()
      : typeof env.TOKENTRACKER_GROK_BILLING_BASE_URL === "string"
        ? env.TOKENTRACKER_GROK_BILLING_BASE_URL.trim()
        : "";
  if (explicit) return explicit.replace(/\/$/, "");
  return DEFAULT_BILLING_BASE_URL;
}

function grokValNumber(value) {
  if (value == null) return null;
  if (typeof value === "object" && "val" in value) {
    return grokValNumber(value.val);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function grokIsoReset(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value.trim());
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usedPercent, resetAt }) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

/**
 * Map Grok's USAGE_PERIOD_TYPE_* enum (or a bare "weekly"/"monthly" string)
 * into a short period key the UI can switch labels on.
 */
function normalizeGrokPeriodType(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const upper = value.trim().toUpperCase();
  if (upper.includes("WEEK")) return "weekly";
  if (upper.includes("MONTH")) return "monthly";
  if (upper.includes("DAY") || upper.includes("DAILY")) return "daily";
  if (upper.includes("HOUR")) return "hourly";
  return null;
}

/**
 * Infer weekly vs monthly from period length when the API omits `currentPeriod.type`
 * (legacy monthly payloads only expose start/end dates).
 */
function inferGrokPeriodTypeFromDates(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const days = (endMs - startMs) / 86_400_000;
  if (days <= 8) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  return null;
}

function isGrokInstalled({ home, env } = {}) {
  const grokHome = resolveGrokHome({ home, env });
  const authPath = path.join(grokHome, "auth.json");
  if (fs.existsSync(authPath)) return true;
  return fs.existsSync(path.join(grokHome, "sessions"));
}

function loadGrokAuthEntry({ home, env } = {}) {
  const authPath = path.join(resolveGrokHome({ home, env }), "auth.json");
  if (!fs.existsSync(authPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    for (const value of Object.values(parsed)) {
      if (!value || typeof value !== "object") continue;
      const key = typeof value.key === "string" ? value.key.trim() : "";
      if (key) return { entry: value, authPath };
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function readGrokAccessToken({ home, env } = {}) {
  const loaded = loadGrokAuthEntry({ home, env });
  const key = typeof loaded?.entry?.key === "string" ? loaded.entry.key.trim() : "";
  return key || null;
}

/**
 * Parse either:
 *   - Unified billing (`?format=credits`): weekly/monthly period + creditUsagePercent
 *   - Legacy monthly credits: monthlyLimit / used + calendar-month billingPeriod*
 *
 * Prefer the unified shape; legacy remains as a fallback for older accounts.
 */
function normalizeGrokBillingResponse(body) {
  const config = body?.config;
  if (!config || typeof config !== "object") {
    throw new Error("Could not parse Grok billing: missing config");
  }

  const currentPeriod =
    config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : null;

  const periodStart =
    grokIsoReset(currentPeriod?.start) || grokIsoReset(config.billingPeriodStart);
  const resetAt = grokIsoReset(currentPeriod?.end) || grokIsoReset(config.billingPeriodEnd);

  let periodType = normalizeGrokPeriodType(currentPeriod?.type);
  if (!periodType) {
    periodType = inferGrokPeriodTypeFromDates(periodStart, resetAt);
  }

  // Unified billing: overall pool percent is what gates "You hit your weekly limit".
  // productUsage is attribution only (GrokBuild vs GrokChat), not a separate cap.
  let usedPercent = clampPercent(config.creditUsagePercent);
  if (usedPercent === null && Array.isArray(config.productUsage)) {
    const buildEntry = config.productUsage.find(
      (entry) => entry && typeof entry === "object" && entry.product === "GrokBuild",
    );
    if (buildEntry) usedPercent = clampPercent(buildEntry.usagePercent);
  }

  // Legacy monthly credit counters (pre-unified / non-format=credits responses).
  const monthlyLimit = grokValNumber(config.monthlyLimit);
  const used = grokValNumber(config.used);
  if (usedPercent === null && Number.isFinite(monthlyLimit) && monthlyLimit > 0 && Number.isFinite(used)) {
    usedPercent = (used / monthlyLimit) * 100;
    if (!periodType) periodType = "monthly";
  }

  const onDemandCap = grokValNumber(config.onDemandCap);
  const onDemandUsed = grokValNumber(config.onDemandUsed);

  const primaryWindow = buildWindow({ usedPercent, resetAt });

  let secondaryWindow = null;
  if (Number.isFinite(onDemandCap) && onDemandCap > 0 && Number.isFinite(onDemandUsed)) {
    secondaryWindow = buildWindow({
      usedPercent: (onDemandUsed / onDemandCap) * 100,
      resetAt,
    });
  }

  if (!primaryWindow && !secondaryWindow) {
    throw new Error("Could not parse Grok billing: no quota windows in response");
  }

  return {
    period_type: periodType,
    monthly_credits_limit: monthlyLimit,
    monthly_credits_used: used,
    // Effective percent used for the primary bar (API creditUsagePercent, or
    // productUsage / legacy monthly counters when the raw field is absent).
    credit_usage_percent: usedPercent == null ? null : clampPercent(usedPercent),
    on_demand_cap: onDemandCap,
    on_demand_used: onDemandUsed,
    billing_period_start: periodStart,
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
  };
}

/**
 * Fetch Grok billing. Prefer `?format=credits` (unified weekly/monthly pool
 * used by the Grok Build TUI). Fall back to the bare `/v1/billing` payload for
 * older accounts that only expose monthlyLimit/used.
 */
async function fetchGrokBilling(accessToken, { fetchImpl = fetch, baseUrl, env } = {}) {
  const root = (baseUrl || resolveGrokBillingBaseUrl(env)).replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const creditsUrl = `${root}/v1/billing?format=credits`;
  const creditsRes = await fetchImpl(creditsUrl, { method: "GET", headers });
  if (creditsRes.status === 401 || creditsRes.status === 403) {
    throw new Error("Not logged in to Grok Build. Run `grok login` in Terminal to authenticate.");
  }
  if (creditsRes.ok) {
    return creditsRes.json();
  }

  // Non-auth failure on format=credits → try the legacy shape once.
  const legacyRes = await fetchImpl(`${root}/v1/billing`, { method: "GET", headers });
  if (legacyRes.status === 401 || legacyRes.status === 403) {
    throw new Error("Not logged in to Grok Build. Run `grok login` in Terminal to authenticate.");
  }
  if (!legacyRes.ok) {
    throw new Error(
      `Grok billing API returned ${legacyRes.status} (format=credits: ${creditsRes.status})`,
    );
  }
  return legacyRes.json();
}

async function fetchGrokLimits({ home, env, fetchImpl = fetch } = {}) {
  if (!isGrokInstalled({ home, env })) {
    return { configured: false };
  }
  const accessToken = readGrokAccessToken({ home, env });
  if (!accessToken) {
    return { configured: false };
  }
  try {
    const body = await fetchGrokBilling(accessToken, { fetchImpl, env });
    return {
      configured: true,
      error: null,
      ...normalizeGrokBillingResponse(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

module.exports = {
  resolveGrokHome,
  resolveGrokBillingBaseUrl,
  isGrokInstalled,
  loadGrokAuthEntry,
  readGrokAccessToken,
  normalizeGrokPeriodType,
  normalizeGrokBillingResponse,
  fetchGrokBilling,
  fetchGrokLimits,
};
