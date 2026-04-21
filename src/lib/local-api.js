const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { DEFAULT_BASE_URL, resolveRuntimeConfig } = require("./runtime-config");

const SYNC_TIMEOUT_MS = 120_000;
const TRACKER_BIN = path.resolve(__dirname, "../../bin/tracker.js");

// ---------------------------------------------------------------------------
// Per-model pricing (USD per million tokens)
// ---------------------------------------------------------------------------

// Rates per million tokens (USD). Sources: LiteLLM, OpenAI, Google, OpenRouter.
const MODEL_PRICING = {
  // ── Anthropic Claude ──
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20250414": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  // ── OpenAI GPT / Codex ──
  "gpt-5": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache_read: 0.025 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-xhigh-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.2": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high-fast": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
  "gpt-5.4-medium": { input: 1.5, output: 10, cache_read: 0.15 },
  "o3": { input: 2, output: 8, cache_read: 0.5 },
  // ── Google Gemini (official: ai.google.dev/pricing) ──
  "gemini-2.5-pro": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_read: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cache_read: 0.05 },
  "gemini-3-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  // ── Cursor Composer ──
  "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  "composer-1.5": { input: 3.5, output: 17.5, cache_read: 0.35 },
  "composer-2": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2-fast": { input: 1.5, output: 7.5, cache_read: 0.15 },
  // ── Moonshot Kimi (official: platform.moonshot.ai) ──
  "kimi-for-coding": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5-free": { input: 0, output: 0, cache_read: 0 },
  // ── AWS Kiro (Kiro IDE + Kiro CLI — both route through Bedrock, most
  //    commonly claude-sonnet-4; rates mirror the sonnet-4 table below so
  //    costs stay consistent with the real underlying model when a Bedrock
  //    model_id isn't exposed). Mirrored byte-for-byte in
  //    dashboard/edge-patches/tokentracker-leaderboard-refresh.ts for
  //    leaderboard estimated_cost_usd. ──
  "kiro-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "kiro-cli-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // ── Misc / Free ──
  "glm-4.7-free": { input: 0, output: 0, cache_read: 0 },
  "nemotron-3-super-free": { input: 0, output: 0, cache_read: 0 },
  "mimo-v2-pro-free": { input: 0, output: 0, cache_read: 0 },
  "minimax-m2.1-free": { input: 0, output: 0, cache_read: 0 },
  "MiniMax-M2.1": { input: 0.5, output: 3, cache_read: 0.05 },
};

const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function getModelPricing(model) {
  if (!model) return ZERO_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  // Fuzzy match for common model families
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("gpt-5.4")) return MODEL_PRICING["gpt-5.4"];
  if (lower.includes("gpt-5.3")) return MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return MODEL_PRICING["gpt-5.2"];
  if (lower.includes("gpt-5.1")) return MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  if (lower.includes("gemini-3")) return MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("kimi")) return MODEL_PRICING["kimi-k2.5"];
  if (lower.includes("kiro")) return MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("composer")) return MODEL_PRICING["composer-1"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

function computeRowCost(row) {
  const pricing = getModelPricing(row.model);
  // For OpenAI/Codex-family rollouts, `output_tokens` already includes any
  // reasoning tokens (the OpenAI API's `completion_tokens` is inclusive),
  // so adding a separate `reasoning_output_tokens * output_rate` term
  // double-charges that slice. ccusage models this the same way. For other
  // sources we keep the explicit reasoning term because `reasoning` is not
  // guaranteed to be folded into `output_tokens`.
  const reasoningIncludedInOutput = row.source === "codex" || row.source === "every-code";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (pricing.output || 0);
  return (
    ((row.input_tokens || 0) * (pricing.input || 0) +
      (row.output_tokens || 0) * (pricing.output || 0) +
      (row.cached_input_tokens || 0) * (pricing.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (pricing.cache_write || 0) +
      reasoningCost) /
    1_000_000
  );
}

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
      seen.set(key, row);
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
  if (!isLegacyInclusiveCodexRow(row)) return row;
  return {
    ...row,
    input_tokens: Number(row.input_tokens || 0) - Number(row.cached_input_tokens || 0),
  };
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
    a.billable_total_tokens += row.total_tokens || 0;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += row.input_tokens || 0;
    a.output_tokens += row.output_tokens || 0;
    a.cached_input_tokens += row.cached_input_tokens || 0;
    a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    a.conversation_count += row.conversation_count || 0;
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
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
    bucket.billable_total_tokens += row.total_tokens || 0;
    bucket.input_tokens += row.input_tokens || 0;
    bucket.output_tokens += row.output_tokens || 0;
    bucket.cached_input_tokens += row.cached_input_tokens || 0;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    bucket.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    bucket.conversation_count += row.conversation_count || 0;
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

function runSyncCommand(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TRACKER_BIN, "sync"], {
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
// Main handler factory
// ---------------------------------------------------------------------------

function createLocalApiHandler({ queuePath }) {
  const qp = queuePath || resolveQueuePath();

  // Server-side cookie relay: captures auth cookies from InsForge cloud responses
  // so that both browser and WKWebView share the same login session via the proxy.
  // Persisted to disk so cookies survive server restarts.
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

  function normalizeCookieHeader(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join("; ");
    return typeof value === "string" ? value : "";
  }

  function buildRelayCookieHeader(clientCookieHeader) {
    const normalizedClientCookieHeader = normalizeCookieHeader(clientCookieHeader);
    if (relayCookies.size === 0) return normalizedClientCookieHeader;
    const clientPairs = new Map();
    if (normalizedClientCookieHeader) {
      for (const part of normalizedClientCookieHeader.split(";")) {
        const eqIdx = part.indexOf("=");
        if (eqIdx < 1) continue;
        const n = part.substring(0, eqIdx).trim();
        if (n) clientPairs.set(n, part.trim());
      }
    }
    // Merge relay cookies (client takes precedence)
    for (const [name, raw] of relayCookies) {
      if (clientPairs.has(name)) continue;
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
        const proxyHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (key === "host" || key === "connection") continue;
          proxyHeaders[key] = value;
        }
        const hasClientCookie = normalizeCookieHeader(proxyHeaders["cookie"]).trim().length > 0;
        const hasCsrfHeader = typeof proxyHeaders["x-csrf-token"] === "string" && proxyHeaders["x-csrf-token"].trim().length > 0;
        const shouldInjectRelayCookies =
          p !== "/api/auth/refresh" || hasClientCookie || hasCsrfHeader;

        // Inject relay cookies so WebView benefits from browser's login session.
        // Refresh requests need either a browser cookie or an explicit CSRF token;
        // otherwise replaying a stale persisted refresh cookie just manufactures
        // Invalid CSRF errors on startup.
        const mergedCookie = shouldInjectRelayCookies
          ? buildRelayCookieHeader(proxyHeaders["cookie"])
          : normalizeCookieHeader(proxyHeaders["cookie"]);
        if (mergedCookie) proxyHeaders["cookie"] = mergedCookie;

        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
        const proxyRes = await fetch(targetUrl, {
          method: req.method || "GET",
          headers: proxyHeaders,
          body,
          credentials: "include",
          redirect: "manual",
        });
        const responseHeaders = [...proxyRes.headers.entries()]
          .filter(([k]) => !["transfer-encoding", "connection"].includes(k.toLowerCase()))
          .map(([k, v]) => {
            if (k.toLowerCase() === "set-cookie") {
              const rewritten = v.replace(/;\s*[Dd]omain=[^;]*/g, "; Domain=localhost");
              captureSetCookies(rewritten);
              return [k, rewritten];
            }
            return [k, v];
          });
        res.writeHead(proxyRes.status, Object.fromEntries(responseHeaders));
        const resBody = Buffer.from(await proxyRes.arrayBuffer());
        if (
          p === "/api/auth/refresh"
          && proxyRes.status === 403
          && !hasClientCookie
          && !hasCsrfHeader
          && /invalid csrf token/i.test(resBody.toString("utf8"))
        ) {
          clearRelayCookies("stale refresh cookie without local CSRF context");
        }
        res.end(resBody);
      } catch (e) {
        json(res, { error: `Auth proxy error: ${e?.message || e}` }, 502);
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
        const result = await runSyncCommand(extraEnv);
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

    // --- usage-summary ---
    if (p === "/functions/tokentracker-usage-summary") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const rows = readQueueData(qp);
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
        from, to, days: daily.length,
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
      const rows = readQueueData(qp);
      const daily = aggregateByDay(rows, timeZoneContext).filter((d) => d.day >= from && d.day <= to);
      json(res, { from, to, data: daily });
      return true;
    }

    // --- usage-heatmap ---
    if (p === "/functions/tokentracker-usage-heatmap") {
      const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
      const timeZoneContext = getTimeZoneContext(url);
      const rows = readQueueData(qp);
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
        cells.push({ day, total_tokens: data?.total_tokens || 0, billable_total_tokens: billable, level: calcLevel(billable) });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const weeksArr = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeksArr.push(cells.slice(i, i + 7));
      }
      json(res, { from, to, week_starts_on: "sun", active_days: cells.filter((c) => c.billable_total_tokens > 0).length, streak_days: 0, weeks: weeksArr });
      return true;
    }

    // --- usage-model-breakdown ---
    if (p === "/functions/tokentracker-usage-model-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const rows = readQueueData(qp).filter((r) => {
        if (!r.hour_start) return false;
        const d = rowDayKey(r, timeZoneContext);
        return d >= from && d <= to;
      });

      const bySource = new Map();
      for (const row of rows) {
        const src = row.source || "unknown";
        const mdl = row.model || "unknown";
        if (!bySource.has(src))
          bySource.set(src, { source: src, totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }, models: new Map() });
        const sa = bySource.get(src);
        sa.totals.total_tokens += row.total_tokens || 0;
        sa.totals.billable_total_tokens += row.total_tokens || 0;
        sa.totals.input_tokens += row.input_tokens || 0;
        sa.totals.output_tokens += row.output_tokens || 0;
        sa.totals.cached_input_tokens += row.cached_input_tokens || 0;
        sa.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        sa.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        if (!sa.models.has(mdl))
          sa.models.set(mdl, { model: mdl, model_id: mdl, totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" } });
        const ma = sa.models.get(mdl);
        ma.totals.total_tokens += row.total_tokens || 0;
        ma.totals.billable_total_tokens += row.total_tokens || 0;
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
        from, to, days: 0, sources,
        pricing: { model: "per-model", pricing_mode: "per_token_type", source: "litellm", effective_from: new Date().toISOString().slice(0, 10) },
      });
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
              project_ref: `https://${src}.ai`,
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
      });
      return true;
    }

    // --- usage-hourly (stub for day-view) ---
    if (p === "/functions/tokentracker-usage-hourly") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const timeZoneContext = getTimeZoneContext(url);
      const rows = readQueueData(qp);
      const data = aggregateHourlyByDay(rows, day, timeZoneContext);
      json(res, { day, data });
      return true;
    }

    // --- usage-monthly (stub for trend view) ---
    if (p === "/functions/tokentracker-usage-monthly") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const rows = readQueueData(qp);
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
        a.billable_total_tokens += row.total_tokens || 0;
        a.input_tokens += row.input_tokens || 0;
        a.output_tokens += row.output_tokens || 0;
        a.cached_input_tokens += row.cached_input_tokens || 0;
        a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        a.conversation_count += row.conversation_count || 0;
      }
      json(res, { from, to, data: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)) });
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
};
