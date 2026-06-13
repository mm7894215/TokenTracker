const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { DEFAULT_BASE_URL, resolveRuntimeConfig } = require("./runtime-config");
const {
  filterRowsByUsageScope,
  getSourceScope,
  listExcludedSources,
  normalizeUsageScope,
} = require("./source-metadata");
const { accountSlugFor, fetchAccountUsage, mintAccessToken } = require("./cloud-account");
const { getOrCreateMachineId, computeStableMachineId } = require("./machine-id");

const SYNC_TIMEOUT_MS = 120_000;
const TRACKER_BIN = path.resolve(__dirname, "../../bin/tracker.js");

// Avatar proxy (see /api/avatar-proxy below). In-memory LRU; survives the
// CLI server lifetime, which is good enough — the dashboard reloads cheaply.
const AVATAR_PROXY_TTL_MS = 60 * 60 * 1000; // 1h
const AVATAR_PROXY_MAX_BYTES = 512 * 1024; // 512 KiB per image
const AVATAR_PROXY_MAX_ENTRIES = 64;
const avatarProxyCache = new Map();

// ---------------------------------------------------------------------------
// Per-model pricing — delegated to src/lib/pricing/
//   - CURATED overrides (kiro-*, hy3-*, composer-*, kimi-for-coding, etc.)
//   - LiteLLM live data (mainstream claude / gpt-5 / gemini), 24h disk-cached
//   - Bundled seed snapshot for first-install / offline fallback
// ---------------------------------------------------------------------------

const {
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
} = require("./pricing");

const {
  computeClaudeCategoryBreakdown,
  unsupportedSourcePayload: unsupportedCategoryPayload,
} = require("./claude-categorizer");

const { computeCodexContextBreakdown } = require("./codex-context-breakdown");

// ---------------------------------------------------------------------------
// Queue data helpers
// ---------------------------------------------------------------------------

function resolveQueuePath() {
  const home = os.homedir();
  return path.join(home, ".tokentracker", "tracker", "queue.jsonl");
}

function readProjectQueueData(projectQueuePath) {
  let raw;
  try {
    raw = fs.readFileSync(projectQueuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readProjectQueueData: failed to read:", e?.message || e);
    }
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const seen = new Map();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const key = `${row.project_key || ""}|${row.source || ""}|${row.hour_start || ""}`;
      // Same legacy-row corrections as the main queue (codex inclusive-input,
      // cursor billable=0) so both read paths report identical numbers.
      seen.set(key, normalizeQueueRow(row));
    } catch {
      // skip malformed
    }
  }
  return Array.from(seen.values());
}

function isLegacyInclusiveCodexRow(row) {
  if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
  const inputTokens = Number(row.input_tokens || 0);
  const cachedInputTokens = Number(row.cached_input_tokens || 0);
  const outputTokens = Number(row.output_tokens || 0);
  const totalTokens = Number(row.total_tokens || 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
  if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
  // Legacy Codex queue rows stored input inclusive of cache reads, while
  // total_tokens remained input + output. Canonical rows keep input as pure
  // non-cached input, so cache-heavy legacy rows can be identified by this
  // exact invariant.
  return totalTokens === inputTokens + outputTokens;
}

function normalizeQueueRow(row) {
  let normalized = row;
  if (isLegacyInclusiveCodexRow(normalized)) {
    normalized = {
      ...normalized,
      input_tokens:
        Number(normalized.input_tokens || 0) - Number(normalized.cached_input_tokens || 0),
    };
  }
  // Legacy Cursor rows from versions ≤ 0.26.5 wrote billable_total_tokens = 0
  // for "Included in Pro" / "Enterprise" / "no charge" records (kind-based
  // gating in cursor-config.js#normalizeCursorUsage). The dashboard headline
  // sums billable_total_tokens across sources, so those rows silently
  // disappeared from the displayed total once any other source contributed
  // non-zero billable usage (GitHub issue #106). Treat billing and usage as
  // orthogonal: bump billable up to total_tokens at read time so historical
  // queue.jsonl entries render correctly without requiring a file rewrite.
  const sourceName = String(normalized.source || "").toLowerCase();
  if (sourceName === "cursor") {
    const totalTokens = Number(normalized.total_tokens || 0);
    const billable = Number(normalized.billable_total_tokens || 0);
    if (totalTokens > 0 && billable < totalTokens) {
      normalized = { ...normalized, billable_total_tokens: totalTokens };
    }
  }
  return normalized;
}

function readQueueData(queuePath) {
  let raw;
  try {
    raw = fs.readFileSync(queuePath, "utf8");
  } catch (e) {
    // ENOENT is legitimate (never synced yet); anything else is a signal we
    // don't want to hide behind an empty array forever — the dashboard would
    // otherwise render "0 tokens" with no clue the queue was unreadable.
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readQueueData: failed to read queue:", e?.message || e);
    }
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  // Parse row-by-row so a single corrupted line (partial write, disk-full
  // truncation, …) does not wipe out every other row with it.
  const parsed = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) {
    console.error(
      `[LocalAPI] readQueueData: skipped ${malformed}/${lines.length} malformed line(s) in ${queuePath}`,
    );
  }
  // Deduplicate: each sync appends cumulative totals per bucket, so for
  // each (source, model, hour_start) keep only the latest (last) entry.
  const seen = new Map();
  for (const row of parsed) {
    const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
    seen.set(key, normalizeQueueRow(row));
  }
  return Array.from(seen.values());
}

function rowDayKey(row, timeZoneContext) {
  const hs = row.hour_start;
  if (!hs) return "";
  if (
    timeZoneContext &&
    (timeZoneContext.timeZone || Number.isFinite(timeZoneContext.offsetMinutes))
  ) {
    const parts = getZonedParts(new Date(hs), timeZoneContext);
    const key = formatPartsDayKey(parts);
    if (key) return key;
  }
  return hs.slice(0, 10);
}

function aggregateByDay(rows, timeZoneContext = null) {
  const byDay = new Map();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const a = byDay.get(day);
    a.total_tokens += row.total_tokens || 0;
    a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += row.input_tokens || 0;
    a.output_tokens += row.output_tokens || 0;
    a.cached_input_tokens += row.cached_input_tokens || 0;
    a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    a.conversation_count += row.conversation_count || 0;

    if (!a.models) {
      a.models = {};
    }
    const model = row.model || "unknown";
    a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function buildCodexCategoryFallbackFromQueue(queueRows, { from, to, timeZoneContext }) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let conversationCount = 0;

  for (const row of queueRows || []) {
    if ((row?.source || "") !== "codex") continue;
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (from && day < from) continue;
    if (to && day > to) continue;
    totals.input_tokens += Number(row.input_tokens || 0);
    totals.cached_input_tokens += Number(row.cached_input_tokens || 0);
    totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
    totals.output_tokens += Number(row.output_tokens || 0);
    totals.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
    totals.total_tokens += Number(row.total_tokens || 0);
    conversationCount += Number(row.conversation_count || 0);
  }

  return {
    source: "codex",
    scope: "supported",
    breakdown_status: "queue_fallback",
    totals,
    session_count: 0,
    message_count: conversationCount,
    fallback: "queue_totals",
    message_breakdown: {
      categories: [
        {
          key: "user_input",
          name: "User input",
          totals: {
            input_tokens: totals.input_tokens,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.input_tokens,
          },
        },
        {
          key: "conversation_history",
          name: "Conversation history",
          totals: {
            input_tokens: 0,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.cached_input_tokens + totals.cache_creation_input_tokens,
          },
        },
        {
          key: "assistant_response",
          name: "Assistant response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
            reasoning_output_tokens: 0,
            total_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
          },
        },
      ].sort((a, b) => Number(b.totals.total_tokens || 0) - Number(a.totals.total_tokens || 0)),
      privacy: {
        includes_content: false,
        note: "Queue fallback includes aggregated token categories only; message text is never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: 0,
      tools: [],
      categories: [],
      tools_total: 0,
      privacy: {
        includes_inputs: false,
        note: "Codex rollout sessions were unavailable; totals come from TokenTracker queue rows.",
      },
    },
    exec_command_breakdown: {
      by_type: [],
      by_exit: [],
    },
  };
}

function getRequestedUsageScope(url) {
  if (url.searchParams.get("include_account_level") === "1") return "all";
  return normalizeUsageScope(url.searchParams.get("scope"));
}

function scopedQueueRows(queuePath, url) {
  const scope = getRequestedUsageScope(url);
  const allRows = readQueueData(queuePath);
  return {
    scope,
    allRows,
    rows: filterRowsByUsageScope(allRows, scope),
    excludedSources: listExcludedSources(allRows, scope),
  };
}

function getTimeZoneContext(url) {
  const tz = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  return {
    timeZone: tz || null,
    offsetMinutes: Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null,
  };
}

function getZonedParts(date, { timeZone, offsetMinutes } = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(dt);
      const values = parts.reduce((acc, part) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {});
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
        return { year, month, day, hour, minute, second };
      }
    } catch (_e) {
      // fall through
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    second: dt.getSeconds(),
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function aggregateHourlyByDay(rows, dayKey, timeZoneContext) {
  const byHour = new Map();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext);
    if (!parts) continue;
    if (formatPartsDayKey(parts) !== dayKey) continue;
    const hourKey = `${dayKey}T${String(parts.hour).padStart(2, "0")}:00:00`;
    if (!byHour.has(hourKey)) {
      byHour.set(hourKey, {
        hour: hourKey,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const bucket = byHour.get(hourKey);
    bucket.total_tokens += row.total_tokens || 0;
    bucket.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    bucket.input_tokens += row.input_tokens || 0;
    bucket.output_tokens += row.output_tokens || 0;
    bucket.cached_input_tokens += row.cached_input_tokens || 0;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    bucket.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    bucket.conversation_count += row.conversation_count || 0;

    if (!bucket.models) {
      bucket.models = {};
    }
    const model = row.model || "unknown";
    bucket.models[model] = (bucket.models[model] || 0) + (row.total_tokens || 0);
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
}

// ---------------------------------------------------------------------------
// Sync helper
// ---------------------------------------------------------------------------

function trimOutput(value, max = 4000) {
  const t = String(value || "");
  return t.length <= max ? t : t.slice(t.length - max);
}

function normalizeRemoteHttpBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_e) {
    return null;
  }
}

function resolveAllowedInsforgeBaseUrl(value) {
  const requested = normalizeRemoteHttpBaseUrl(value);
  if (!requested) return null;

  const runtime = resolveRuntimeConfig();
  const allowed = new Set(
    [runtime.baseUrl, DEFAULT_BASE_URL]
      .map((entry) => normalizeRemoteHttpBaseUrl(entry))
      .filter(Boolean),
  );

  return allowed.has(requested) ? requested : null;
}

function parseCookieHeader(value) {
  const out = new Map();
  if (typeof value !== "string" || !value.trim()) return out;
  for (const part of value.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (key) out.set(key, rawValue);
  }
  return out;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function hasAllowedLoopbackOrigin(headers = {}) {
  const candidates = [headers.origin, headers.referer];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    try {
      const url = new URL(String(raw));
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
    } catch (_e) {
      return false;
    }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function runSyncCommand(extraEnv = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [TRACKER_BIN, "sync"];
    if (opts.drain === true) args.push("--drain");
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      fn(v);
    };
    const tid = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        Object.assign(new Error("Sync timed out"), {
          code: "SYNC_TIMEOUT",
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
        }),
      );
    }, SYNC_TIMEOUT_MS);
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e) => {
      finish(reject, Object.assign(e, { stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
    });
    child.on("close", (code) => {
      const r = { code: code ?? 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) };
      code === 0
        ? finish(resolve, r)
        : finish(reject, Object.assign(new Error(r.stderr || r.stdout || `exit ${r.code}`), r));
    });
  });
}

// ---------------------------------------------------------------------------
// Project detection helpers
// ---------------------------------------------------------------------------

function parseGitUrl(url) {
  if (!url) return null;
  const ssh = url.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const http = url.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

function extractProjectFromCwd(cwd) {
  const home = os.homedir();
  if (!cwd || cwd === home) return null;
  const rel = cwd.replace(home + "/", "");
  const parts = rel.split("/").filter((p) => p && !p.startsWith(".") && p !== "ext-global");
  return parts.length > 0 ? parts[0] : null;
}

function scanCodexProjects(projectMap) {
  const dir = path.join(os.homedir(), ".codex", "sessions");
  try {
    for (const year of fs.readdirSync(dir)) {
      const yp = path.join(dir, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          const files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
          for (const file of files.slice(0, 200)) {
            try {
              const first = fs.readFileSync(path.join(dp, file), "utf8").split("\n")[0];
              const d = JSON.parse(first);
              if (d.git?.repository_url) {
                const p = parseGitUrl(d.git.repository_url);
                if (p) {
                  const key = `${p.owner}/${p.repo}`;
                  if (!projectMap.has(key))
                    projectMap.set(key, {
                      project_key: key,
                      project_ref: d.git.repository_url,
                      count: 0,
                    });
                  projectMap.get(key).count++;
                }
              }
            } catch (_e) {}
          }
        }
      }
    }
  } catch (_e) {}
}

function findSubagentsDirs(dir, depth) {
  const out = [];
  if (depth > 3) return out;
  try {
    for (const item of fs.readdirSync(dir)) {
      const fp = path.join(dir, item);
      if (!fs.statSync(fp).isDirectory()) continue;
      if (item === "subagents") out.push(fp);
      else out.push(...findSubagentsDirs(fp, depth + 1));
    }
  } catch (_e) {}
  return out;
}

function scanClaudeProjects(projectMap) {
  const dir = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const subDir of findSubagentsDirs(dir, 0)) {
      const files = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files.slice(0, 100)) {
        try {
          const first = fs.readFileSync(path.join(subDir, file), "utf8").split("\n")[0];
          if (!first) continue;
          const d = JSON.parse(first);
          const name = extractProjectFromCwd(d.cwd);
          if (name) {
            if (!projectMap.has(name))
              projectMap.set(name, {
                project_key: name,
                project_ref: `file://${d.cwd}`,
                count: 0,
              });
            projectMap.get(name).count++;
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// IP check API proxy: dashboard/src/pages/IpCheckPage.jsx is a native React
// page that calls ip.net.coffee's data endpoints (/api/iprisk, /api/geoip,
// /api/dns/result, /favicons, /claude/status.json). Browser-side fetch can't
// hit them cross-origin from the dashboard, so we reverse-proxy /proxy/ipcheck/*
// to https://ip.net.coffee/* and strip embedding-hostile headers.
// (Previously this proxy also served the upstream HTML page for an iframe;
// the iframe and its HTML-rewrite path have been removed.)
// ---------------------------------------------------------------------------

const IP_CHECK_PROXY_PREFIX = "/proxy/ipcheck";
const IP_CHECK_TARGET = "https://ip.net.coffee";

// HTTP hop-by-hop headers (RFC 7230 §6.1) plus headers undici/fetch manages
// internally. Forwarding any of these to `fetch(...)` either silently breaks
// the request (host being wrong) or, on stricter undici versions like the
// 6.24.1 shipped with Node 22.22.2, throws UND_ERR_INVALID_ARG and turns
// every proxied POST into a 502. Keep this set authoritative for every
// reverse-proxy site in this module.
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
]);

// Strip forbidden + hop-by-hop headers when forwarding an inbound request to
// fetch(). Honours the Connection header's named-headers list (RFC 7230 §6.1)
// so values like `Connection: keep-alive, x-custom` also drop x-custom.
function buildProxyHeaders(headers) {
  const entries =
    headers && typeof headers.entries === "function"
      ? Array.from(headers.entries())
      : Object.entries(headers || {});

  const connectionNamed = new Set();
  const normalized = [];
  for (const [rawKey, rawValue] of entries) {
    if (rawValue == null) continue;
    const key = String(rawKey).toLowerCase();
    normalized.push([key, rawValue]);
    if (key === "connection") {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const v of values) {
        String(v)
          .split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean)
          .forEach((part) => connectionNamed.add(part));
      }
    }
  }

  const out = {};
  for (const [key, rawValue] of normalized) {
    if (HOP_BY_HOP_HEADERS.has(key) || connectionNamed.has(key)) continue;
    if (Array.isArray(rawValue)) {
      const joined = rawValue.filter((e) => e != null).map(String).join(", ");
      if (joined) out[key] = joined;
      continue;
    }
    out[key] = String(rawValue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

function createLocalApiHandler({ queuePath }) {
  const qp = queuePath || resolveQueuePath();

  // Server-side cookie relay: captures auth cookies from InsForge cloud responses
  // so that both browser and WKWebView share the same login session via the proxy.
  // Persisted to disk so cookies survive server restarts.
  const csrfRelayCookieName = "insforge_csrf_token";
  let relayCookies = new Map();
  const localAuthToken = crypto.randomBytes(24).toString("hex");
  const trackerDataDir = path.join(os.homedir(), ".tokentracker", "tracker");
  const cookiePath = path.join(trackerDataDir, "relay-cookies.json");

  // Load persisted cookies on startup
  try {
    if (!fs.existsSync(trackerDataDir)) fs.mkdirSync(trackerDataDir, { recursive: true });
    if (fs.existsSync(cookiePath)) {
      const content = fs.readFileSync(cookiePath, "utf8");
      const saved = JSON.parse(content);
      if (saved && typeof saved === "object") {
        let count = 0;
        for (const [k, v] of Object.entries(saved)) {
          relayCookies.set(k, v);
          count++;
        }
        if (count > 0) console.log(`[LocalAPI] Loaded ${count} relay cookies from ${cookiePath}`);
      }
    }
  } catch (e) {
    console.error("[LocalAPI] Failed to load relay cookies:", e.message);
  }

  function persistRelayCookies() {
    try {
      // Sticky semantics: never replace an existing on-disk session with an empty cookie map.
      if (relayCookies.size === 0) return;

      const json = JSON.stringify(Object.fromEntries(relayCookies));
      fs.writeFileSync(cookiePath, json, { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      console.error("[LocalAPI] Failed to persist relay cookies:", e.message);
    }
  }

  function clearRelayCookies(reason) {
    if (relayCookies.size === 0) return;
    relayCookies.clear();
    try {
      if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
    } catch (e) {
      console.error("[LocalAPI] Failed to clear relay cookies:", e.message);
      return;
    }
    if (reason) console.warn(`[LocalAPI] Cleared relay cookies: ${reason}`);
  }

  function captureSetCookies(headerValue) {
    if (!headerValue) return;
    const parts = headerValue.split(/,(?=\s*\w+=)/);
    let changed = false;
    for (const raw of parts) {
      const eqIdx = raw.indexOf("=");
      if (eqIdx < 1) continue;
      const name = raw.substring(0, eqIdx).trim();
      if (!name) continue;

      // Basic sticky logic: if it's a deletion cookie (Max-Age=0 or past date),
      // we only remove it if we have it.
      const lower = raw.toLowerCase();
      const isDeletion = lower.includes("max-age=0") || lower.includes("expires=thu, 01 jan 1970");
      
      if (isDeletion) {
        if (relayCookies.has(name)) {
          relayCookies.delete(name);
          changed = true;
          console.log(`[LocalAPI] Cookie deleted: ${name}`);
        }
      } else {
        const oldVal = relayCookies.get(name);
        if (oldVal !== raw.trim()) {
          relayCookies.set(name, raw.trim());
          changed = true;
          console.log(`[LocalAPI] Cookie captured: ${name}`);
        }
      }
    }
    if (changed) persistRelayCookies();
  }

  function getRelayCookieValue(name, { decode = false } = {}) {
    const raw = relayCookies.get(name);
    if (!raw || typeof raw !== "string") return "";
    const pair = raw.split(";")[0] || "";
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) return "";
    const value = pair.substring(eqIdx + 1).trim();
    if (!decode) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function captureAuthTokensFromBody(bodyBuffer, contentType) {
    if (!bodyBuffer || !String(contentType || "").toLowerCase().includes("application/json")) return;
    let parsed = null;
    try {
      parsed = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
      return;
    }
    let changed = false;
    const token = typeof parsed?.csrfToken === "string" ? parsed.csrfToken.trim() : "";
    if (token) {
      const cookie = `${csrfRelayCookieName}=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
      if (relayCookies.get(csrfRelayCookieName) !== cookie) {
        relayCookies.set(csrfRelayCookieName, cookie);
        changed = true;
      }
    }
    const refreshToken = typeof parsed?.refreshToken === "string" ? parsed.refreshToken.trim() : "";
    if (refreshToken) {
      const cookie = `insforge_refresh_token=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax`;
      if (relayCookies.get("insforge_refresh_token") !== cookie) {
        relayCookies.set("insforge_refresh_token", cookie);
        changed = true;
      }
    }
    if (changed) persistRelayCookies();
  }

  // --- Account (cross-device) view for the native popover ---------------
  // The popover follows the dashboard: it shows aggregated cross-device data
  // only when the user is signed in (a relayed refresh token exists) AND cloud
  // sync is on. Cloud sync is a dashboard (WebView) preference persisted in
  // localStorage; the dashboard mirrors it here via POST
  // /functions/tokentracker-cloud-sync-pref so the auth-unaware popover can key
  // off the same flag. Defaults OFF, exactly like the dashboard toggle.
  const cloudSyncPrefPath = path.join(trackerDataDir, "cloud-sync-pref.json");
  let cloudSyncPrefCache;
  function getCloudSyncPref() {
    if (cloudSyncPrefCache === undefined) {
      try {
        cloudSyncPrefCache = JSON.parse(fs.readFileSync(cloudSyncPrefPath, "utf8"))?.enabled === true;
      } catch {
        cloudSyncPrefCache = false;
      }
    }
    return cloudSyncPrefCache;
  }
  function setCloudSyncPref(enabled) {
    cloudSyncPrefCache = Boolean(enabled);
    try {
      if (!fs.existsSync(trackerDataDir)) fs.mkdirSync(trackerDataDir, { recursive: true });
      fs.writeFileSync(
        cloudSyncPrefPath,
        JSON.stringify({ enabled: cloudSyncPrefCache, updatedAt: new Date().toISOString() }),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (e) {
      console.error("[LocalAPI] Failed to persist cloud sync pref:", e.message);
    }
  }

  function getRefreshTokenForCloud() {
    return getRelayCookieValue("insforge_refresh_token", { decode: true });
  }
  function setRelayRefreshToken(token) {
    if (!token || typeof token !== "string") return;
    const cookie = `insforge_refresh_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
    if (relayCookies.get("insforge_refresh_token") !== cookie) {
      relayCookies.set("insforge_refresh_token", cookie);
      persistRelayCookies();
    }
  }
  function setRelayCsrfToken(token) {
    if (!token || typeof token !== "string") return;
    const cookie = `${csrfRelayCookieName}=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
    if (relayCookies.get(csrfRelayCookieName) !== cookie) {
      relayCookies.set(csrfRelayCookieName, cookie);
      persistRelayCookies();
    }
  }

  async function issueDeviceTokenForDrainSync(queuePathForMachineId) {
    if (!getCloudSyncPref()) return null;
    const refreshToken = getRefreshTokenForCloud();
    if (!refreshToken) return null;

    const runtime = resolveRuntimeConfig();
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL;
    const minted = await mintAccessToken({
      baseUrl,
      anonKey: runtime.anonKey,
      refreshToken,
      timeoutMs: runtime.httpTimeoutMs,
    });
    if (!minted?.accessToken) return null;
    if (minted.refreshToken) setRelayRefreshToken(minted.refreshToken);
    if (minted.csrfToken) setRelayCsrfToken(minted.csrfToken);

    const machineId = getOrCreateMachineId(queuePathForMachineId);
    if (!machineId) return null;

    const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${minted.accessToken}`,
    };
    if (runtime.anonKey) headers.apikey = runtime.anonKey;

    let timeoutId;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller && runtime.httpTimeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), runtime.httpTimeoutMs);
    }

    const dashboardPlatform =
      process.platform === "darwin" ? "MacIntel" :
        process.platform === "win32" ? "Win32" :
          process.platform === "linux" ? "Linux x86_64" :
            "web";

    const res = await fetch(`${root}/functions/tokentracker-device-token-issue`, {
      method: "POST",
      headers,
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        // 必须和 dashboard/src/lib/cloud-sync.ts 使用同一个设备身份。
        // 旧云端设备按 (platform, device_name) 认领；如果这里发明
        // local-sync 身份，会多出一个 active device，账户视图会把历史求和两次。
        device_name: `Token Tracker (dashboard) #${machineId.slice(0, 8)}`,
        platform: dashboardPlatform,
        machine_id: machineId,
      }),
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const token = typeof data?.token === "string" ? data.token.trim() : "";
    return token || null;
  }

  // Returns "served" when the cross-device aggregate was written to `res`, or
  // "fallthrough" when the caller should serve the local single-machine data.
  // Any failure (not signed in, cloud sync off, network/auth error) falls
  // through so the popover always renders something.
  async function tryServeAccountView(usageSlug, url, res) {
    if (!getCloudSyncPref()) return "fallthrough";
    const refreshToken = getRefreshTokenForCloud();
    if (!refreshToken) return "fallthrough";
    const runtime = resolveRuntimeConfig();
    const envTimeout = process.env.TOKENTRACKER_HTTP_TIMEOUT_MS
      ? parseInt(process.env.TOKENTRACKER_HTTP_TIMEOUT_MS, 10)
      : 0;
    const timeoutMs = envTimeout > 0 ? envTimeout : 4000;
    try {
      const out = await fetchAccountUsage({
        usageSlug,
        searchParams: url.searchParams,
        baseUrl: runtime.baseUrl || DEFAULT_BASE_URL,
        anonKey: runtime.anonKey,
        refreshToken,
        timeoutMs,
      });
      if (!out || out.data == null) return "fallthrough";
      if (out.rotatedRefreshToken) setRelayRefreshToken(out.rotatedRefreshToken);
      if (out.rotatedCsrfToken) setRelayCsrfToken(out.rotatedCsrfToken);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-TokenTracker-Account-View": "1",
      });
      res.end(JSON.stringify(out.data));
      return "served";
    } catch (e) {
      // Signed in + cloud sync on, but the cloud read failed (offline, token
      // rejected, edge error, or timeout). Fall back to local data rather than erroring.
      if (resolveRuntimeConfig().debug) {
        console.warn(`[LocalAPI] account view fallback for ${usageSlug}:`, e?.message || e);
      }
      return "fallthrough";
    }
  }

  function normalizeCookieHeader(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join("; ");
    return typeof value === "string" ? value : "";
  }

  function buildRelayCookieHeader(clientCookieHeader, { relayPrecedenceNames = [] } = {}) {
    const normalizedClientCookieHeader = normalizeCookieHeader(clientCookieHeader);
    if (relayCookies.size === 0) return normalizedClientCookieHeader;
    const relayPrecedence = new Set(relayPrecedenceNames);
    const clientPairs = new Map();
    if (normalizedClientCookieHeader) {
      for (const part of normalizedClientCookieHeader.split(";")) {
        const eqIdx = part.indexOf("=");
        if (eqIdx < 1) continue;
        const n = part.substring(0, eqIdx).trim();
        if (n) clientPairs.set(n, part.trim());
      }
    }
    // Merge relay cookies. Normal requests keep client precedence; refresh
    // recovery can opt relay cookies into precedence over stale WebView cookies.
    for (const [name, raw] of relayCookies) {
      if (clientPairs.has(name) && !relayPrecedence.has(name)) continue;
      const scIdx = raw.indexOf(";");
      const pair = scIdx > 0 ? raw.substring(0, scIdx).trim() : raw;
      clientPairs.set(name, pair);
    }
    return [...clientPairs.values()].join("; ");
  }

  // Ephemeral auth bridge: WebView sets a "native" flag before opening system browser
  // for OAuth. The callback page (in browser) checks this flag to decide whether to
  // relay the code back to the app or handle it as a normal web flow.
  let _nativeAuthPending = false;
  let _nativeAuthExpiry = 0;

  function isAuthorizedLocalMutation(req) {
    const headerToken = req?.headers?.["x-tokentracker-local-auth"];
    const cookieToken = parseCookieHeader(req?.headers?.cookie).get("tokentracker_local_auth");
    const token = typeof headerToken === "string" && headerToken.trim()
      ? headerToken.trim()
      : cookieToken || "";
    if (!token || token !== localAuthToken) return false;
    return hasAllowedLoopbackOrigin(req?.headers || {});
  }

  return async function handleLocalApi(req, res, url) {
    const p = url.pathname;

    if (p === "/api/local-auth") {
      if (String(req.method || "GET").toUpperCase() !== "GET") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ token: localAuthToken }));
      return true;
    }

    // --- Auth bridge: native OAuth flag (WebView ↔ system browser) ---
    if (p === "/api/auth-bridge/verifier") {
      const method = String(req.method || "GET").toUpperCase();
      if (method === "PUT" || method === "POST") {
        if (!isAuthorizedLocalMutation(req)) {
          json(res, { error: "Unauthorized" }, 401);
          return true;
        }
        const body = await readJsonBody(req);
        _nativeAuthPending = Boolean(body?.native);
        _nativeAuthExpiry = Date.now() + 5 * 60 * 1000; // 5 min TTL
        json(res, { ok: true });
        return true;
      }
      if (method === "GET") {
        const isNative = _nativeAuthPending && Date.now() < _nativeAuthExpiry;
        _nativeAuthPending = false; // one-time read
        _nativeAuthExpiry = 0;
        json(res, { native: isNative });
        return true;
      }
      json(res, { error: "Method Not Allowed" }, 405);
      return true;
    }

    // --- auth proxy: forward /api/auth/* to InsForge cloud ---
    if (p.startsWith("/api/auth/")) {
      const runtime = resolveRuntimeConfig();
      const insforgeBase = runtime.baseUrl || DEFAULT_BASE_URL;
      try {
        const targetUrl = `${insforgeBase.replace(/\/$/, "")}${p}${url.search || ""}`;
        const proxyHeaders = buildProxyHeaders(req.headers);
        const hasClientCookie = normalizeCookieHeader(proxyHeaders["cookie"]).trim().length > 0;
        const hasCsrfHeader = typeof proxyHeaders["x-csrf-token"] === "string" && proxyHeaders["x-csrf-token"].trim().length > 0;
        const relayCsrfToken = getRelayCookieValue(csrfRelayCookieName);
        const relayRefreshToken = getRelayCookieValue("insforge_refresh_token", { decode: true });
        // A cookie-less client (fresh WebView after an app update/restart) has no
        // browser session to pair a CSRF token with — the persisted refresh token
        // replayed through the mobile flow is the only viable recovery. The relay
        // csrf token must NOT force the cookie/csrf path here: background mobile
        // rotations (cloud-account.js) can leave it stale, and a stale csrf turns
        // recovery into 403 Invalid CSRF and signs the user out.
        const shouldUseRelayRefreshFallback =
          p === "/api/auth/refresh" && !hasClientCookie && relayRefreshToken;
        if (p === "/api/auth/refresh" && relayCsrfToken && !shouldUseRelayRefreshFallback) {
          proxyHeaders["x-csrf-token"] = relayCsrfToken;
        }
        const hasEffectiveCsrfHeader =
          hasCsrfHeader ||
          (typeof proxyHeaders["x-csrf-token"] === "string" && proxyHeaders["x-csrf-token"].trim().length > 0);
        let shouldInjectRelayCookies =
          p !== "/api/auth/refresh" || hasClientCookie || hasEffectiveCsrfHeader;
        if (shouldUseRelayRefreshFallback) {
          shouldInjectRelayCookies = false;
        }

        // Inject relay cookies so WebView benefits from browser's login session.
        // Refresh requests need either a browser cookie or an explicit CSRF token;
        // otherwise replaying a stale persisted refresh cookie just manufactures
        // Invalid CSRF errors on startup.
        const originalCookieHeader = normalizeCookieHeader(proxyHeaders["cookie"]);
        const mergedCookie = shouldInjectRelayCookies
          ? buildRelayCookieHeader(originalCookieHeader, {
              relayPrecedenceNames: p === "/api/auth/refresh"
                ? [csrfRelayCookieName, "insforge_refresh_token"]
                : [],
            })
          : originalCookieHeader;
        const injectedRelayCookies =
          shouldInjectRelayCookies && relayCookies.size > 0 && mergedCookie !== originalCookieHeader;
        if (mergedCookie) proxyHeaders["cookie"] = mergedCookie;

        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        let proxyBody = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
        let effectiveTargetUrl = targetUrl;
        if (shouldUseRelayRefreshFallback) {
          effectiveTargetUrl = `${insforgeBase.replace(/\/$/, "")}/api/auth/refresh?client_type=mobile`;
          proxyHeaders["content-type"] = "application/json";
          delete proxyHeaders["content-length"];
          proxyBody = Buffer.from(JSON.stringify({ refresh_token: relayRefreshToken }), "utf8");
        }
        let proxyRes = await fetch(effectiveTargetUrl, {
          method: req.method || "GET",
          headers: proxyHeaders,
          body: proxyBody,
          credentials: "include",
          redirect: "manual",
        });
        let resBody = Buffer.from(await proxyRes.arrayBuffer());

        // Stale-CSRF rescue: 403 Invalid CSRF on refresh does NOT mean the
        // session is dead — background mobile rotations (cloud-account.js) can
        // desync the relayed csrf from a still-valid refresh token. Replay the
        // persisted refresh token through the csrf-free mobile flow before
        // letting the client sign out.
        const isStaleCsrf403 =
          p === "/api/auth/refresh"
          && proxyRes.status === 403
          && /invalid csrf token/i.test(resBody.toString("utf8"));
        if (isStaleCsrf403 && relayRefreshToken && !shouldUseRelayRefreshFallback) {
          const rescueHeaders = { ...proxyHeaders, "content-type": "application/json" };
          delete rescueHeaders["cookie"];
          delete rescueHeaders["x-csrf-token"];
          delete rescueHeaders["content-length"];
          const rescueRes = await fetch(
            `${insforgeBase.replace(/\/$/, "")}/api/auth/refresh?client_type=mobile`,
            {
              method: "POST",
              headers: rescueHeaders,
              body: JSON.stringify({ refresh_token: relayRefreshToken }),
              credentials: "include",
              redirect: "manual",
            },
          );
          if (rescueRes.ok) {
            proxyRes = rescueRes;
            resBody = Buffer.from(await rescueRes.arrayBuffer());
          }
        }

        // Error responses must not mutate relay state: a 403's deletion
        // set-cookie (insforge_refresh_token=; Expires=1970) would otherwise
        // destroy a still-valid persisted session.
        const allowRelayCapture = proxyRes.status < 400;
        const responseHeaders = [...proxyRes.headers.entries()]
          .filter(([k]) => !["transfer-encoding", "connection"].includes(k.toLowerCase()))
          .map(([k, v]) => {
            if (k.toLowerCase() === "set-cookie") {
              const rewritten = v.replace(/;\s*[Dd]omain=[^;]*/g, "; Domain=localhost");
              if (allowRelayCapture) captureSetCookies(rewritten);
              return [k, rewritten];
            }
            return [k, v];
          });
        res.writeHead(proxyRes.status, Object.fromEntries(responseHeaders));
        if (proxyRes.status >= 200 && proxyRes.status < 300) {
          if (p === "/api/auth/logout") {
            clearRelayCookies("sign out");
          } else {
            captureAuthTokensFromBody(resBody, proxyRes.headers.get("content-type"));
          }
        }
        if (
          isStaleCsrf403
          && proxyRes.status === 403
          && injectedRelayCookies
          && !hasClientCookie
        ) {
          clearRelayCookies("stale refresh cookie without local CSRF context");
        }
        res.end(resBody);
      } catch (e) {
        json(res, { error: `Auth proxy error: ${e?.message || e}` }, 502);
      }
      return true;
    }

    // --- ip-check proxy: reverse-proxy ip.net.coffee (issue #81) ---
    // Lock-down: GET/HEAD only, restricted path prefixes, do not forward
    // browser credentials or fingerprintable headers. Without these limits
    // /proxy/ipcheck is an open reverse-proxy any local process can abuse
    // (exfiltrate dashboard cookies, anonymously POST through user IP).
    if (p.startsWith(`${IP_CHECK_PROXY_PREFIX}/`) || p === IP_CHECK_PROXY_PREFIX) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const targetPath = p === IP_CHECK_PROXY_PREFIX
        ? "/"
        : p.slice(IP_CHECK_PROXY_PREFIX.length) || "/";
      const ALLOWED_PREFIXES = [
        "/api/geoip/",
        "/api/geoip-batch",
        "/api/iprisk/",
        "/api/dns/result/",
        "/claude/status.json",
        "/favicons/",
        "/ip/",
      ];
      if (!ALLOWED_PREFIXES.some((prefix) => targetPath.startsWith(prefix))) {
        json(res, { error: "Path not allowed" }, 403);
        return true;
      }
      const targetUrl = `${IP_CHECK_TARGET}${targetPath}${url.search || ""}`;
      try {
        // Whitelist forwarded headers — no cookies, no auth, no fingerprintable
        // identity. Only what the upstream needs to negotiate content. Do not
        // set `host` explicitly: undici derives it from the URL, and some
        // versions reject a manual host header on fetch() (same forbidden-
        // header family that broke /api/auth/* in 5/13).
        const proxyHeaders = {
          accept: req.headers["accept"] || "*/*",
          "accept-language": req.headers["accept-language"] || "en",
          "accept-encoding": req.headers["accept-encoding"] || "gzip",
          "user-agent": "TokenTracker/IPCheck (https://www.tokentracker.cc)",
          referer: `${IP_CHECK_TARGET}${targetPath}`,
        };

        const proxyRes = await fetch(targetUrl, {
          method,
          headers: proxyHeaders,
          redirect: "manual",
        });

        const stripped = new Set([
          "transfer-encoding",
          "connection",
          "content-length",
          "content-encoding",
          "x-frame-options",
          "content-security-policy",
          "cross-origin-opener-policy",
          "cross-origin-embedder-policy",
          "cross-origin-resource-policy",
        ]);
        const responseHeaders = [...proxyRes.headers.entries()].filter(
          ([k]) => !stripped.has(k.toLowerCase()),
        );

        const resBody = Buffer.from(await proxyRes.arrayBuffer());
        res.writeHead(proxyRes.status, Object.fromEntries(responseHeaders));
        res.end(resBody);
      } catch (e) {
        json(res, { error: `IP check proxy error: ${e?.message || e}` }, 502);
      }
      return true;
    }

    // --- avatar proxy: fetch third-party avatars server-side ---
    // Why: WKWebView in TokenTrackerBar fails to load some users' Google /
    // GitHub avatars directly (network-stack / proxy / TLS quirks vary by
    // environment), even when the same URL renders fine in Safari. Proxying
    // through Node's fetch — which honors system proxy + cookies-of-none —
    // produces a same-origin <img> the WKWebView always accepts.
    // Lock-down: GET only; host allowlist of well-known avatar CDNs (no open
    // proxy); strip cookies/auth; small in-memory cache.
    if (p === "/api/avatar-proxy") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const target = url.searchParams.get("url");
      if (!target) {
        json(res, { error: "Missing url" }, 400);
        return true;
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        json(res, { error: "Invalid url" }, 400);
        return true;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        json(res, { error: "Only http(s) allowed" }, 400);
        return true;
      }
      const AVATAR_HOST_ALLOWLIST = [
        "lh3.googleusercontent.com",
        "lh4.googleusercontent.com",
        "lh5.googleusercontent.com",
        "lh6.googleusercontent.com",
        "avatars.githubusercontent.com",
        "secure.gravatar.com",
        "www.gravatar.com",
        "gravatar.com",
        "cdn.discordapp.com",
        "pbs.twimg.com",
        "abs.twimg.com",
        "api.dicebear.com",
      ];
      const hostOk = AVATAR_HOST_ALLOWLIST.some(
        (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
      );
      if (!hostOk) {
        json(res, { error: "Host not allowed" }, 403);
        return true;
      }

      const cacheKey = parsed.toString();
      const now = Date.now();
      const cached = avatarProxyCache.get(cacheKey);
      if (cached && now - cached.fetchedAt < AVATAR_PROXY_TTL_MS) {
        res.writeHead(200, {
          "Content-Type": cached.contentType,
          "Cache-Control": "public, max-age=3600",
          "X-Avatar-Cache": "HIT",
        });
        res.end(method === "HEAD" ? undefined : cached.body);
        return true;
      }

      try {
        const upstream = await fetch(cacheKey, {
          method,
          redirect: "follow",
          headers: {
            accept: req.headers["accept"] || "image/*",
            "accept-language": req.headers["accept-language"] || "en",
            "user-agent": "TokenTracker/AvatarProxy (https://www.tokentracker.cc)",
          },
        });
        if (!upstream.ok) {
          json(res, { error: `Upstream ${upstream.status}` }, upstream.status);
          return true;
        }
        const contentType = upstream.headers.get("content-type") || "image/png";
        if (!contentType.toLowerCase().startsWith("image/")) {
          json(res, { error: "Not an image" }, 415);
          return true;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length <= AVATAR_PROXY_MAX_BYTES) {
          // Simple LRU: drop oldest if over capacity.
          if (avatarProxyCache.size >= AVATAR_PROXY_MAX_ENTRIES) {
            const oldestKey = avatarProxyCache.keys().next().value;
            if (oldestKey) avatarProxyCache.delete(oldestKey);
          }
          avatarProxyCache.set(cacheKey, { body, contentType, fetchedAt: now });
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
          "X-Avatar-Cache": "MISS",
        });
        res.end(method === "HEAD" ? undefined : body);
      } catch (e) {
        json(res, { error: `Avatar proxy error: ${e?.message || e}` }, 502);
      }
      return true;
    }

    // --- local-sync (POST) ---
    if (p === "/functions/tokentracker-local-sync") {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      try {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const extraEnv = {};
        const drain = body.drain === true;
        if (typeof body.deviceToken === "string" && body.deviceToken.trim()) {
          extraEnv.TOKENTRACKER_DEVICE_TOKEN = body.deviceToken.trim();
        }
        if (body.insforgeBaseUrl != null) {
          const allowedBaseUrl = resolveAllowedInsforgeBaseUrl(body.insforgeBaseUrl);
          if (!allowedBaseUrl) {
            json(res, { ok: false, error: "Unsupported insforgeBaseUrl override" }, 400);
            return true;
          }
          extraEnv.TOKENTRACKER_INSFORGE_BASE_URL = allowedBaseUrl;
        }
        if (drain && !extraEnv.TOKENTRACKER_DEVICE_TOKEN && getCloudSyncPref() && getRefreshTokenForCloud()) {
          const issuedToken = await issueDeviceTokenForDrainSync(qp).catch(() => null);
          if (!issuedToken) {
            json(res, { ok: false, error: "Unable to issue cloud device token for drain sync" }, 502);
            return true;
          }
          extraEnv.TOKENTRACKER_DEVICE_TOKEN = issuedToken;
        }
        const result = await runSyncCommand(extraEnv, { drain });
        try {
          const { resetUsageLimitsCache } = require("./usage-limits");
          resetUsageLimitsCache();
        } catch (_e) {
          // ignore if module load fails
        }
        json(res, { ok: true, ...result });
      } catch (e) {
        json(res, { ok: false, error: e?.message, code: e?.code ?? null, stdout: e?.stdout || "", stderr: e?.stderr || "" }, 500);
      }
      return true;
    }

    // --- wrapped (year-end summary, à la Spotify Wrapped) ---
    if (p === "/functions/tokentracker-wrapped") {
      const yearParam = url.searchParams.get("year");
      const year = yearParam ? Number(yearParam) : null;
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const { aggregateWrapped } = require("./wrapped-aggregator");
      const summary = aggregateWrapped(rows, year ? { year } : {});
      json(res, { scope, excluded_sources: excludedSources, ...summary });
      return true;
    }

    // --- account (cross-device) view proxy for the native popover ---
    // When ?account=1 and the user is signed in with cloud sync on, serve the
    // same cross-device aggregate the dashboard shows; otherwise tag the
    // response (X-TokenTracker-Account-View: 0) so the popover knows it got
    // local single-machine data, and fall through to the local handler below.
    if (url.searchParams.get("account") === "1") {
      const usageSlug = p.startsWith("/functions/") ? p.slice("/functions/".length) : "";
      if (accountSlugFor(usageSlug)) {
        const result = await tryServeAccountView(usageSlug, url, res);
        if (result === "served") return true;
        res.setHeader("X-TokenTracker-Account-View", "0");
      }
    }

    // --- usage-summary ---
    if (p === "/functions/tokentracker-usage-summary") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext).filter((d) => d.day >= from && d.day <= to);
      const totals = daily.reduce(
        (acc, r) => {
          acc.total_tokens += r.total_tokens;
          acc.billable_total_tokens += r.billable_total_tokens;
          acc.total_cost_usd += r.total_cost_usd || 0;
          acc.input_tokens += r.input_tokens;
          acc.output_tokens += r.output_tokens;
          acc.cached_input_tokens += r.cached_input_tokens;
          acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
          acc.reasoning_output_tokens += r.reasoning_output_tokens;
          acc.conversation_count += r.conversation_count;
          return acc;
        },
        { total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 },
      );
      const totalCost = totals.total_cost_usd;

      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);
      const allDaily = aggregateByDay(rows, timeZoneContext);

      const shiftDay = (dayStr, delta) => {
        const d = new Date(`${dayStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      const collectDays = (n) => {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
          const ds = shiftDay(todayStr, -i);
          const dd = allDaily.find((x) => x.day === ds);
          if (dd) out.push(dd);
        }
        return out;
      };
      const sumDays = (days) =>
        days.reduce((a, r) => {
          a.billable_total_tokens += r.billable_total_tokens;
          a.conversation_count += r.conversation_count;
          return a;
        }, { billable_total_tokens: 0, conversation_count: 0 });

      const l7 = collectDays(7);
      const l30 = collectDays(30);
      const l7t = sumDays(l7);
      const l30t = sumDays(l30);
      const l7fromStr = shiftDay(todayStr, -6);
      const l30fromStr = shiftDay(todayStr, -29);

      json(res, {
        from, to, days: daily.length, scope, excluded_sources: excludedSources,
        totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
        rolling: {
          last_7d: { from: l7fromStr, to: todayStr, active_days: l7.length, totals: l7t },
          last_30d: { from: l30fromStr, to: todayStr, active_days: l30.length, totals: l30t, avg_per_active_day: l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0 },
        },
      });
      return true;
    }

    // --- usage-daily ---
    if (p === "/functions/tokentracker-usage-daily") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext).filter((d) => d.day >= from && d.day <= to);
      json(res, { from, to, scope, excluded_sources: excludedSources, data: daily });
      return true;
    }

    // --- usage-heatmap ---
    if (p === "/functions/tokentracker-usage-heatmap") {
      const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext);
      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);
      const end = new Date(`${todayStr}T00:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
      const from = start.toISOString().slice(0, 10);
      const to = end.toISOString().slice(0, 10);
      const byDay = new Map(daily.map((d) => [d.day, d]));

      const allValues = daily.map((d) => d.billable_total_tokens).filter((v) => v > 0);
      const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
      const calcLevel = (v) => {
        if (v <= 0) return 0;
        if (maxValue === 0) return 1;
        const r = v / maxValue;
        if (r <= 0.25) return 1;
        if (r <= 0.5) return 2;
        if (r <= 0.75) return 3;
        return 4;
      };

      // Build cells and group into weeks (array of 7-cell arrays) for the dashboard
      const cells = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const day = cursor.toISOString().slice(0, 10);
        const data = byDay.get(day);
        const billable = data?.billable_total_tokens || 0;
        cells.push({ day, total_tokens: data?.total_tokens || 0, billable_total_tokens: billable, level: calcLevel(billable), models: data?.models || null });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const weeksArr = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeksArr.push(cells.slice(i, i + 7));
      }

      let totalCostUsd = 0;
      for (const d of daily) {
        if (d.day >= from && d.day <= to) {
          totalCostUsd += d.total_cost_usd || 0;
        }
      }

      json(res, { 
        from, 
        to, 
        scope, 
        excluded_sources: excludedSources, 
        week_starts_on: "sun", 
        active_days: cells.filter((c) => c.billable_total_tokens > 0).length, 
        streak_days: 0, 
        weeks: weeksArr,
        total_cost_usd: totalCostUsd
      });
      return true;
    }

    // --- usage-model-breakdown ---
    if (p === "/functions/tokentracker-usage-model-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows: scopedRows, scope, excludedSources } = scopedQueueRows(qp, url);
      const rows = scopedRows.filter((r) => {
        if (!r.hour_start) return false;
        const d = rowDayKey(r, timeZoneContext);
        return d >= from && d <= to;
      });

      const bySource = new Map();
      for (const row of rows) {
        const src = row.source || "unknown";
        const mdl = row.model || "unknown";
        if (!bySource.has(src))
          bySource.set(src, { source: src, source_scope: getSourceScope(src), totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }, models: new Map() });
        const sa = bySource.get(src);
        sa.totals.total_tokens += row.total_tokens || 0;
        sa.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        sa.totals.input_tokens += row.input_tokens || 0;
        sa.totals.output_tokens += row.output_tokens || 0;
        sa.totals.cached_input_tokens += row.cached_input_tokens || 0;
        sa.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        sa.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        if (!sa.models.has(mdl))
          sa.models.set(mdl, { model: mdl, model_id: mdl, totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" } });
        const ma = sa.models.get(mdl);
        ma.totals.total_tokens += row.total_tokens || 0;
        ma.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        ma.totals.input_tokens += row.input_tokens || 0;
        ma.totals.output_tokens += row.output_tokens || 0;
        ma.totals.cached_input_tokens += row.cached_input_tokens || 0;
        ma.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        ma.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
      }

      const sources = Array.from(bySource.values()).map((s) => {
        s.models = Array.from(s.models.values())
          .map((m) => {
            const cost = computeRowCost({
              ...m.totals,
              model: m.model,
              source: s.source,
            });
            return { ...m, totals: { ...m.totals, total_cost_usd: cost.toFixed(6) } };
          })
          .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
        const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
        s.totals.total_cost_usd = sourceCost.toFixed(6);
        return s;
      });

      json(res, {
        from, to, days: 0, scope, excluded_sources: excludedSources, sources,
        pricing: { model: "per-model", pricing_mode: "per_token_type", source: "litellm", effective_from: new Date().toISOString().slice(0, 10) },
      });
      return true;
    }

    // --- usage-category-breakdown (Claude + Codex) ---
    // Claude: splits historical Claude usage into seven semantic categories
    // mirroring Claude Code's /context view (approx).
    // Codex: provides a tool-oriented breakdown, attributing per-turn token
    // deltas to observed tool calls (heuristic).
    if (p === "/functions/tokentracker-usage-category-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const requestedSource = (url.searchParams.get("source") || "claude").trim().toLowerCase();
      if (requestedSource === "claude") {
        try {
          const result = await computeClaudeCategoryBreakdown({ from, to, projectDir: process.cwd() });
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown:", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("claude"), error: "compute_failed" }, 500);
        }
        return true;
      }

      if (requestedSource === "codex") {
        try {
          const timeZoneContext = getTimeZoneContext(url);
          const result = await computeCodexContextBreakdown({
            from,
            to,
            top: 50,
            timeZoneContext,
          });
          if (!Number(result?.totals?.total_tokens || 0)) {
            const fallback = buildCodexCategoryFallbackFromQueue(readQueueData(qp), {
              from,
              to,
              timeZoneContext,
            });
            json(res, { from, to, ...fallback });
            return true;
          }
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown(codex):", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("codex"), error: "compute_failed" }, 500);
        }
        return true;
      }

      json(res, { from, to, ...unsupportedCategoryPayload(requestedSource) });
      return true;
    }

    // --- project-usage-summary ---
    if (p === "/functions/tokentracker-project-usage-summary") {
      // Use the per-project bucket log that rollout.js emits — it already
      // carries the actual tokens attributed to each (project_key, source,
      // hour_start). Falling back to "session-file count × total tokens"
      // (the old behavior) produced pure fiction: every short-and-hot
      // project got the same weight as every long-and-cold one.
      const projectQueuePath = path.join(
        path.dirname(qp),
        "project.queue.jsonl",
      );
      const projectRows = readProjectQueueData(projectQueuePath);

      const byProject = new Map();
      for (const row of projectRows) {
        const key = row.project_key || "unknown";
        if (!byProject.has(key)) {
          byProject.set(key, {
            project_key: key,
            project_ref: row.project_ref || key,
            total_tokens: 0,
            billable_total_tokens: 0,
          });
        }
        const agg = byProject.get(key);
        agg.total_tokens += Number(row.total_tokens || 0);
        agg.billable_total_tokens += Number(row.total_tokens || 0);
        if (!agg.project_ref && row.project_ref) agg.project_ref = row.project_ref;
      }

      // If no project-attributed rows exist yet (user hasn't synced project
      // attribution, or never used a project-capable CLI), fall back to
      // per-source aggregation over the main queue so the panel isn't
      // totally empty. This path used to also exist for the non-empty case
      // and produce wrong numbers; keep it only as the empty fallback.
      let entries;
      if (byProject.size === 0) {
        const rows = readQueueData(qp);
        const bySrc = new Map();
        for (const row of rows) {
          const src = row.source || "unknown";
          if (!bySrc.has(src)) {
            bySrc.set(src, {
              project_key: src,
              // Synthetic source-only row: leave project_ref empty rather than
              // fabricating `https://${src}.ai`, which resolves to unrelated
              // domains (e.g. codex.ai, cursor.ai) and was sent to the
              // dashboard as a clickable href before v0.11.1 / this commit.
              project_ref: "",
              total_tokens: 0,
              billable_total_tokens: 0,
            });
          }
          bySrc.get(src).total_tokens += row.total_tokens || 0;
          bySrc.get(src).billable_total_tokens += row.total_tokens || 0;
        }
        entries = Array.from(bySrc.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .map((e) => ({
            ...e,
            total_tokens: String(e.total_tokens),
            billable_total_tokens: String(e.billable_total_tokens),
          }));
      } else {
        entries = Array.from(byProject.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .map((e) => ({
            ...e,
            total_tokens: String(e.total_tokens),
            billable_total_tokens: String(e.billable_total_tokens),
          }));
      }

      json(res, { generated_at: new Date().toISOString(), entries });
      return true;
    }

    // --- user-status (stub) ---
    if (p === "/functions/tokentracker-user-status") {
      json(res, {
        user_id: "local-user", email: "local@localhost", name: "Local User", is_public: false,
        created_at: new Date().toISOString(),
        pro: { active: true, sources: ["local"], expires_at: null, partial: false, as_of: new Date().toISOString() },
        // Cross-device popover state: whether account aggregation can be served
        // (signed in) and whether the dashboard's cloud-sync toggle is on.
        account: {
          available: Boolean(getRefreshTokenForCloud()),
          cloud_sync_enabled: getCloudSyncPref(),
          account_view: Boolean(getRefreshTokenForCloud()) && getCloudSyncPref(),
        },
      });
      return true;
    }

    // --- cloud-sync preference mirror ---
    // The dashboard's Settings → Account → Cloud sync toggle (a WebView
    // localStorage flag) is mirrored here so the auth-unaware native popover can
    // gate its account (cross-device) view on the same preference.
    if (p === "/functions/tokentracker-cloud-sync-pref") {
      const method = String(req.method || "GET").toUpperCase();
      if (method === "GET") {
        json(res, {
          enabled: getCloudSyncPref(),
          account_available: Boolean(getRefreshTokenForCloud()),
        });
        return true;
      }
      if (method === "POST" || method === "PUT") {
        if (!isAuthorizedLocalMutation(req)) {
          json(res, { ok: false, error: "Unauthorized" }, 401);
          return true;
        }
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        // Reject malformed payloads rather than silently coercing them to a
        // persisted `false` — this file is the shared cloud-sync preference, so
        // a bad write would desync the popover from the dashboard.
        if (typeof body?.enabled !== "boolean") {
          json(res, { ok: false, error: "enabled must be a boolean" }, 400);
          return true;
        }
        setCloudSyncPref(body.enabled);
        json(res, { ok: true, enabled: getCloudSyncPref() });
        return true;
      }
      json(res, { error: "Method Not Allowed" }, 405);
      return true;
    }

    // --- machine-id (stable per-machine device identity for cloud sync) ---
    // The dashboard reads this before issuing a cloud device token so the
    // device_name keys on the MACHINE, not the browser — see
    // getOrCreateMachineId above and dashboard/src/lib/cloud-sync.ts.
    if (p === "/functions/tokentracker-machine-id") {
      json(res, { machineId: getOrCreateMachineId(qp) });
      return true;
    }

    // --- usage-hourly (stub for day-view) ---
    if (p === "/functions/tokentracker-usage-hourly") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const data = aggregateHourlyByDay(rows, day, timeZoneContext);
      json(res, { day, scope, excluded_sources: excludedSources, data });
      return true;
    }

    // --- usage-monthly (stub for trend view) ---
    if (p === "/functions/tokentracker-usage-monthly") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const byMonth = new Map();
      for (const row of rows) {
        if (!row.hour_start) continue;
        const day = rowDayKey(row, timeZoneContext);
        if (!day || day < from || day > to) continue;
        const month = day.slice(0, 7);
        if (!byMonth.has(month))
          byMonth.set(month, { month, total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 });
        const a = byMonth.get(month);
        a.total_tokens += row.total_tokens || 0;
        a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        a.input_tokens += row.input_tokens || 0;
        a.output_tokens += row.output_tokens || 0;
        a.cached_input_tokens += row.cached_input_tokens || 0;
        a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        a.conversation_count += row.conversation_count || 0;

        if (!a.models) {
          a.models = {};
        }
        const model = row.model || "unknown";
        a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
      }
      json(res, { from, to, scope, excluded_sources: excludedSources, data: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)) });
      return true;
    }

    // --- skills manager ---
    if (p === "/functions/tokentracker-skills") {
      const method = String(req.method || "GET").toUpperCase();
      const skills = require("./skills-manager");
      try {
        if (method === "GET") {
          const mode = url.searchParams.get("mode") || "installed";
          if (mode === "installed") {
            json(res, { targets: skills.targetList(), skills: skills.listInstalledSkills() });
            return true;
          }
          if (mode === "repos") {
            json(res, { repos: skills.listRepos() });
            return true;
          }
          if (mode === "discover") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.discoverSkills({ force }));
            return true;
          }
          if (mode === "search") {
            const data = await skills.searchSkillsSh(
              url.searchParams.get("q") || "",
              Number(url.searchParams.get("limit") || 20),
              Number(url.searchParams.get("offset") || 0),
            );
            json(res, data);
            return true;
          }
          if (mode === "popular") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.fetchPopularSkillsSh({ force }));
            return true;
          }
          if (mode === "updates") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.checkUpdates({ force }));
            return true;
          }
          if (mode === "activity") {
            const limit = Number(url.searchParams.get("limit") || 50);
            json(res, { activity: skills.readActivity(limit) });
            return true;
          }
          if (mode === "skill_usage") {
            const force = url.searchParams.get("force") === "1";
            const usage = await require("./skill-usage").scanSkillUsage({ force });
            await ensurePricingLoaded();
            // Join raw per-skill aggregates against installed skills so we can
            // separate user-installed skills (where "dead weight" = unused) from
            // Claude Code built-in tools (bash/agent/…), which dominate the logs
            // and are NOT uninstallable. Cost is priced per-model (source=claude).
            const installed = skills.listInstalledSkills();
            const skillDirectoryLeaf = (value) =>
              String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim().toLowerCase() || "";
            const leafCounts = new Map();
            for (const s of installed) {
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf) leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
            }
            const installedByDirectory = new Map();
            const installedByLeaf = new Map();
            const nameCounts = new Map();
            const installedByName = new Map();
            for (const s of installed) {
              const dir = String(s.directory || "").trim().toLowerCase();
              if (dir) installedByDirectory.set(dir, s);
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf && leafCounts.get(leaf) === 1) installedByLeaf.set(leaf, s);
              const name = String(s.name || "").trim().toLowerCase();
              if (name) {
                nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
                if (!installedByName.has(name)) installedByName.set(name, s);
              }
            }
            const findInstalledSkill = (value) => {
              const norm = String(value || "").trim().toLowerCase();
              if (!norm) return null;
              if (installedByDirectory.has(norm)) return installedByDirectory.get(norm);
              if (installedByLeaf.has(norm)) return installedByLeaf.get(norm);
              if (nameCounts.get(norm) === 1) return installedByName.get(norm);
              if (leafCounts.get(norm) > 1) return null;
              return null;
            };
            const usedSkillIds = new Set();
            const priced = usage.skills.map((entry) => {
              let cost = 0;
              for (const [model, tokens] of Object.entries(entry.models || {})) {
                cost += computeRowCost({ ...tokens, model, source: "claude" });
              }
              const match = findInstalledSkill(entry.skill);
              if (match?.id) usedSkillIds.add(match.id);
              return {
                skill: entry.skill,
                invocations: entry.invocations,
                lastUsedAt: entry.lastUsedAt,
                tokens: entry.tokens,
                cost,
                installed: Boolean(match),
                skillId: match?.id || null,
                directory: match?.directory || null,
              };
            });
            // Installed skills with zero invocations = dead-weight candidates.
            const unusedInstalled = installed
              .filter((s) => !usedSkillIds.has(s.id))
              .map((s) => ({ skillId: s.id, directory: s.directory, name: s.name }));
            json(res, {
              generatedAt: usage.generatedAt,
              scannedFiles: usage.scannedFiles,
              totalInvocations: usage.totalInvocations,
              cached: usage.cached,
              skills: priced,
              unusedInstalled,
            });
            return true;
          }
          json(res, { error: "Unknown skills mode" }, 400);
          return true;
        }

        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          const action = String(body?.action || "");
          if (action === "install") {
            json(res, { ok: true, skill: await skills.installSkill(body.skill, body.targets || ["claude", "codex"]) });
            return true;
          }
          if (action === "uninstall") {
            json(res, { ok: true, ...(skills.uninstallSkill(body.id) || {}) });
            return true;
          }
          if (action === "restore") {
            json(res, { ok: true, skill: skills.restoreSkill(body.id) });
            return true;
          }
          if (action === "set_targets") {
            json(res, { ok: true, skill: skills.setSkillTargets(body.id, body.targets || []) });
            return true;
          }
          if (action === "import_local") {
            json(res, { ok: true, skill: skills.importLocalSkill(body.directory, body.targets || []) });
            return true;
          }
          if (action === "delete_local") {
            json(res, { ok: true, ...(skills.deleteLocalSkill(body.directory, body.targets || []) || {}) });
            return true;
          }
          if (action === "add_repo") {
            json(res, { ok: true, repo: skills.addRepo(body.repo) });
            return true;
          }
          if (action === "remove_repo") {
            json(res, { ok: true, ...(skills.removeRepo(body.owner, body.name) || {}) });
            return true;
          }
          json(res, { ok: false, error: "Unknown skills action" }, 400);
          return true;
        }

        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (e) {
        json(res, { ok: false, error: e?.message || "Unknown skills error" }, 500);
      }
      return true;
    }

    // --- usage-limits ---
    if (p === "/functions/tokentracker-usage-limits") {
      const { getUsageLimits, resetUsageLimitsCache } = require("./usage-limits");
      try {
        const forceRefresh = url.searchParams.get("refresh");
        if (forceRefresh === "1" || forceRefresh === "true") {
          resetUsageLimitsCache();
        }
        const data = await getUsageLimits({
          home: os.homedir(),
          env: process.env,
          platform: process.platform,
        });
        json(res, data);
      } catch (e) {
        json(res, { error: e?.message || "Unknown error" }, 500);
      }
      return true;
    }

    return false;
  };
}

module.exports = {
  createLocalApiHandler,
  resolveAllowedInsforgeBaseUrl,
  resolveQueuePath,
  // Exported for cross-consumer tests (pricing + native contract lock).
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
  // Shared legacy-row correction so every queue reader (main queue, project
  // queue, wrapped aggregator) reports the same numbers for the same data.
  normalizeQueueRow,
  // Machine-stable identity (config.json machineId) — shared with
  // `tracker device-login` so the CLI device-flow anchors its cloud device
  // to the machine, not the hostname.
  getOrCreateMachineId,
  computeStableMachineId,
};
