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

function normalizeGrokBillingResponse(body) {
  const config = body?.config;
  if (!config || typeof config !== "object") {
    throw new Error("Could not parse Grok billing: missing config");
  }

  const monthlyLimit = grokValNumber(config.monthlyLimit);
  const used = grokValNumber(config.used);
  const onDemandCap = grokValNumber(config.onDemandCap);
  const onDemandUsed = grokValNumber(config.onDemandUsed);
  const resetAt = grokIsoReset(config.billingPeriodEnd);

  let primaryWindow = null;
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0 && Number.isFinite(used)) {
    primaryWindow = buildWindow({
      usedPercent: (used / monthlyLimit) * 100,
      resetAt,
    });
  }

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
    monthly_credits_limit: monthlyLimit,
    monthly_credits_used: used,
    on_demand_cap: onDemandCap,
    on_demand_used: onDemandUsed,
    billing_period_start: grokIsoReset(config.billingPeriodStart),
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
  };
}

async function fetchGrokBilling(accessToken, { fetchImpl = fetch, baseUrl, env } = {}) {
  const root = (baseUrl || resolveGrokBillingBaseUrl(env)).replace(/\/$/, "");
  const res = await fetchImpl(`${root}/v1/billing`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Not logged in to Grok Build. Run `grok login` in Terminal to authenticate.");
  }
  if (!res.ok) {
    throw new Error(`Grok billing API returned ${res.status}`);
  }
  return res.json();
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
  normalizeGrokBillingResponse,
  fetchGrokBilling,
  fetchGrokLimits,
};