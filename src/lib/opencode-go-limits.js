const crypto = require("node:crypto");

// OpenCode Go usage limits.
//
// Scrapes the OpenCode Go workspace dashboard
// (https://opencode.ai/workspace/<id>/go) for rolling (5h) / weekly / monthly
// usage. The opencode web console has no public REST API for quota today
// (tracked at anomalyco/opencode#16017, anomalyco/opencode#16513), so we
// read the same data the React app uses by parsing the SSR hydration output
// (SolidStart `queryLiteSubscription` serializes the result as
// `rollingUsage:$R[N]={...usagePercent:N...resetInSec:N...}`) with a
// `data-slot="usage-item"` HTML fallback.
//
// Approach ported from slkiser/opencode-quota PR #41 (MIT, Apr 12 2026,
// 430 tests passing) — that project independently arrived at the same
// scrape with the same env-var names. The cookie is sent verbatim as
// `Cookie: auth=<OPENCODE_GO_AUTH_COOKIE>` per that reference.

const SCRAPED_NUMBER_PATTERN = "([0-9]+(?:\\.[0-9]+)?)";

// Match each window's fields anchor-free, instead of pinning the exact SSR
// wrapper shape. opencode's hydration format around the data changes between
// releases (it dropped the `:$R[N]={…}` wrapper our old regexes required, which
// broke parsing in #225 even though auth worked and the page still carried the
// numbers). The field names (rollingUsage/weeklyUsage/monthlyUsage with
// usagePercent + resetInSec) are stable, so we anchor on those, the way
// steipete/codexbar's OpenCodeGoUsageFetcher does. `[^}]*?` keeps each match
// inside that window's own object, and `"?` tolerates both the unquoted SSR
// form (`usagePercent:2`) and a quoted JSON form (`"usagePercent":2`).
function windowFieldRegex(windowKey, field) {
  return new RegExp(`${windowKey}[^}]*?${field}"?\\s*[:=]+\\s*${SCRAPED_NUMBER_PATTERN}`);
}

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const DEFAULT_SCRAPE_TIMEOUT_MS = 10_000;

function readConfig(env = process.env) {
  if (!env || typeof env !== "object") return null;
  const workspaceId =
    typeof env.OPENCODE_GO_WORKSPACE_ID === "string"
      ? env.OPENCODE_GO_WORKSPACE_ID.trim()
      : "";
  const authCookie =
    typeof env.OPENCODE_GO_AUTH_COOKIE === "string"
      ? env.OPENCODE_GO_AUTH_COOKIE.trim()
      : "";
  if (!authCookie) return null;
  return { workspaceId, authCookie };
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Some payloads encode the percentage as a 0–1 fraction (e.g. 0.02 for 2%).
  // Scale only when strictly below 1 so a genuine "1" stays 1%, not 100%.
  if (n > 0 && n < 1) n *= 100;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usagePercent, resetInSec, nowMs }) {
  const pct = clampPercent(usagePercent);
  if (pct === null) return null;
  const seconds = Number(resetInSec);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const resetAtIso = new Date(nowMs + Math.floor(seconds) * 1000).toISOString();
  return { used_percent: pct, reset_at: resetAtIso };
}

// Pull one window's usagePercent + resetInSec out of the page. The two fields
// are matched independently (order-independent), so it survives field
// reordering as well as wrapper changes.
function parseWindowUsage(html, windowKey) {
  const pctMatch = windowFieldRegex(windowKey, "usagePercent").exec(html);
  if (!pctMatch) return null;
  const usagePercent = Number(pctMatch[1]);
  if (!Number.isFinite(usagePercent)) return null;
  const resetMatch = windowFieldRegex(windowKey, "resetInSec").exec(html);
  const resetInSec = resetMatch ? Number(resetMatch[1]) : 0;
  return { usagePercent, resetInSec: Number.isFinite(resetInSec) ? resetInSec : 0 };
}

// Parse "1 hour 56 minutes" / "6 days 2 hours" / "26 days 17 hours" into
// seconds. The data-slot HTML fallback uses human-readable reset strings
// when the SSR hydration output is absent.
function parseHumanReadableTime(timeStr) {
  if (typeof timeStr !== "string") return null;
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, " ");
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) {
    return 0;
  }
  const dayMatch = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const minuteMatch = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const secondMatch = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  if (!dayMatch && !hourMatch && !minuteMatch && !secondMatch) return null;
  let total = 0;
  if (dayMatch) total += Number(dayMatch[1]) * 86400;
  if (hourMatch) total += Number(hourMatch[1]) * 3600;
  if (minuteMatch) total += Number(minuteMatch[1]) * 60;
  if (secondMatch) total += Number(secondMatch[1]);
  return total;
}

function parseDataSlotFormat(html) {
  const out = {};
  const items = html.split(/data-slot="usage-item"/);
  for (let i = 1; i < items.length; i++) {
    const content = items[i];
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
    if (!usageMatch) continue;
    const usagePercent = Number(usageMatch[1]);
    const resetMatch = content.match(
      /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/,
    );
    if (!resetMatch) continue;
    const resetContent = resetMatch[2]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();
    const resetInSec =
      resetMatch[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);
    if (!Number.isFinite(usagePercent) || resetInSec === null) continue;
    let key = null;
    if (label.includes("rolling")) key = "rolling";
    else if (label.includes("weekly")) key = "weekly";
    else if (label.includes("monthly")) key = "monthly";
    if (key) out[key] = { usagePercent, resetInSec };
  }
  return out;
}

function extractWindows(html, nowMs) {
  let rolling = parseWindowUsage(html, "rollingUsage");
  let weekly = parseWindowUsage(html, "weeklyUsage");
  let monthly = parseWindowUsage(html, "monthlyUsage");
  // Fill any *individual* missing window from the data-slot HTML fallback.
  // Running the fallback only when all three fail loses the case where SSR
  // hydration exposes e.g. rollingUsage but drops weeklyUsage — we'd return
  // `null` for that window even though parseDataSlotFormat() could still
  // recover it from the rendered HTML.
  if (!rolling || !weekly || !monthly) {
    const fallback = parseDataSlotFormat(html);
    rolling = rolling || fallback.rolling || null;
    weekly = weekly || fallback.weekly || null;
    monthly = monthly || fallback.monthly || null;
  }
  return {
    rolling: rolling ? buildWindow({ ...rolling, nowMs }) : null,
    weekly: weekly ? buildWindow({ ...weekly, nowMs }) : null,
    monthly: monthly ? buildWindow({ ...monthly, nowMs }) : null,
  };
}

function sanitizeMessage(text, maxLength = 160) {
  const str = typeof text === "string" ? text : String(text ?? "");
  const squashed = str.replace(/\s+/g, " ").trim();
  return (squashed || "unknown").slice(0, maxLength);
}

function withTimeout(fetchImpl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl;
  return (input, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const next = { ...init, signal: init.signal || controller.signal };
    return fetchImpl(input, next).finally(() => clearTimeout(timer));
  };
}

// TanStack server-function ID for the "list workspaces" query. Generated at
// build time by OpenCode's SolidStart bundler. To update: open opencode.ai
// with DevTools → Network, filter "_server", trigger any workspace load,
// and copy the `id` query parameter from the request URL.
const WORKSPACES_SERVER_ID =
  "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";

async function resolveWorkspaceId(authCookie, fetchImpl, timeoutMs) {
  const serverId = WORKSPACES_SERVER_ID;
  const instanceId = `server-fn:${crypto.randomUUID()}`;

  const headers = {
    "Cookie": `auth=${authCookie}`,
    "X-Server-Id": serverId,
    "X-Server-Instance": instanceId,
    "User-Agent": USER_AGENT,
    "Origin": "https://opencode.ai",
    "Referer": "https://opencode.ai",
    "Accept": "text/javascript, application/json;q=0.9, */*;q=0.8"
  };

  const getUrl = `https://opencode.ai/_server?id=${serverId}`;
  let response;
  try {
    response = await withTimeout(fetchImpl, timeoutMs)(getUrl, {
      method: "GET",
      headers,
    });
  } catch (err) {
    throw new Error(`GET _server failed: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Unauthorized or forbidden (401/403)");
  }

  let text = await response.text();
  let ids = parseWorkspaceIds(text);

  if (ids.length === 0 && !looksSignedOut(text)) {
    const postUrl = "https://opencode.ai/_server";
    const postHeaders = {
      ...headers,
      "Content-Type": "application/json",
    };
    try {
      response = await withTimeout(fetchImpl, timeoutMs)(postUrl, {
        method: "POST",
        headers: postHeaders,
        body: "[]"
      });
      text = await response.text();
      ids = parseWorkspaceIds(text);
    } catch (postErr) {
      // GET returned content but no workspace IDs; POST also failed.
      // Wrap both signals so the caller can surface a useful diagnostic.
      throw new Error(`GET returned no workspace IDs and POST fallback failed: ${postErr.message}`);
    }
  }

  return ids.length > 0 ? ids[0] : null;
}

function parseWorkspaceIds(text) {
  const ids = new Set();
  const re = /id\s*[:=]+\s*\\?"(wrk_[^\\"]+)\\"?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.add(m[1]);
  }
  if (ids.size === 0) {
    try {
      const walk = (o) => {
        if (typeof o === "string" && o.startsWith("wrk_")) {
          ids.add(o);
        } else if (Array.isArray(o)) {
          o.forEach(walk);
        } else if (o && typeof o === "object") {
          Object.values(o).forEach(walk);
        }
      };
      walk(JSON.parse(text));
    } catch (_) {}
  }
  return Array.from(ids);
}

function looksSignedOut(text) {
  const l = String(text).toLowerCase();
  // Use specific phrases to avoid false positives on workspace names containing
  // common words like "login" (e.g. a workspace named "loginServiceApp").
  return l.includes("please log in") || l.includes("sign in to") || l.includes("auth/authorize")
    || l.includes("not associated with an account") || l.includes('actor of type "public"');
}

async function fetchOpencodeGoLimits({
  env = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
  timeoutMs = DEFAULT_SCRAPE_TIMEOUT_MS,
} = {}) {
  const cfg = readConfig(env);
  if (!cfg) return { configured: false };

  let workspaceId = cfg.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = await resolveWorkspaceId(cfg.authCookie, fetchImpl, timeoutMs);
    } catch (err) {
      return { configured: true, error: `Failed to resolve Workspace ID: ${sanitizeMessage(err?.message || err)}` };
    }
    if (!workspaceId) {
      return { configured: true, error: "Could not auto-resolve OpenCode Workspace ID from cookie. Please set OPENCODE_GO_WORKSPACE_ID manually." };
    }
  }

  const url =
    DASHBOARD_URL_PREFIX + encodeURIComponent(workspaceId) + DASHBOARD_URL_SUFFIX;

  let response;
  try {
    response = await withTimeout(fetchImpl, timeoutMs)(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Cookie: `auth=${cfg.authCookie}`,
      },
    });
  } catch (err) {
    return { configured: true, error: sanitizeMessage(err?.message || err) };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      configured: true,
      error: "Not signed in to OpenCode Go. Refresh the auth cookie in OPENCODE_GO_AUTH_COOKIE.",
    };
  }
  if (!response.ok) {
    return {
      configured: true,
      error: `OpenCode Go dashboard error ${response.status}`,
    };
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    return { configured: true, error: sanitizeMessage(err?.message || err) };
  }

  const { rolling, weekly, monthly } = extractWindows(html, nowMs);
  if (!rolling && !weekly && !monthly) {
    return {
      configured: true,
      error:
        "Could not parse any known OpenCode Go dashboard usage windows (rollingUsage, weeklyUsage, monthlyUsage). The page layout may have changed.",
    };
  }

  return {
    configured: true,
    error: null,
    // No `plan_label` — the brand name "OpenCode Go" is the row title, so
    // appending "Go" again would render "OpenCode Go Go" in the panel.
    primary_window: rolling,
    secondary_window: weekly,
    tertiary_window: monthly,
  };
}

module.exports = {
  fetchOpencodeGoLimits,
  readConfig,
  extractWindows,
  parseWindowUsage,
  parseDataSlotFormat,
  parseHumanReadableTime,
  buildWindow,
  resolveWorkspaceId,
  parseWorkspaceIds,
  looksSignedOut,
};
