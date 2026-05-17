// Codex rollout JSONL parser — extracted from codex-context-breakdown.js.
//
// Handles file discovery and per-file parsing. Does NOT hold any aggregation
// state; callers (computeCodexContextBreakdown) own the merge step.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { listRolloutFiles } = require("./rollout");
const {
  emptyTotals,
  addInto,
  inferExecCommandKind,
  sanitizeCommandSignature,
  getExecutableName,
  buildExecStatsEntry,
} = require("./categorizer-utils");

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function dayKeyToIsoBounds(from, to) {
  if (!from && !to) return { fromIso: null, toIso: null };
  const fromDate = from ? new Date(`${from}T00:00:00Z`) : null;
  const toDate = to ? new Date(`${to}T23:59:59Z`) : null;
  if (fromDate && Number.isFinite(fromDate.getTime())) fromDate.setUTCHours(fromDate.getUTCHours() - 14);
  if (toDate && Number.isFinite(toDate.getTime())) toDate.setUTCHours(toDate.getUTCHours() + 14);
  return {
    fromIso: fromDate ? fromDate.toISOString() : null,
    toIso: toDate ? toDate.toISOString() : null,
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  if (!values.year || !values.month || !values.day) return "";
  return `${values.year}-${values.month}-${values.day}`;
}

function getZonedParts(date, timeZoneContext = {}) {
  const { timeZone, offsetMinutes } = timeZoneContext || {};
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hourCycle: "h23",
      }).formatToParts(dt);
    } catch {
      // Fall through to offset handling.
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() - Number(offsetMinutes) * 60_000);
    return [
      { type: "year", value: String(shifted.getUTCFullYear()).padStart(4, "0") },
      { type: "month", value: String(shifted.getUTCMonth() + 1).padStart(2, "0") },
      { type: "day", value: String(shifted.getUTCDate()).padStart(2, "0") },
    ];
  }

  return null;
}

function timestampDayKey(timestamp, timeZoneContext) {
  const ts = typeof timestamp === "string" ? timestamp : "";
  if (!ts) return "";
  const parts = getZonedParts(ts, timeZoneContext);
  const zoned = formatPartsDayKey(parts);
  if (zoned) return zoned;
  return ts.slice(0, 10);
}

function isTimestampInRequestedDayRange(timestamp, { from, to, timeZoneContext } = {}) {
  if (!from && !to) return true;
  const day = timestampDayKey(timestamp, timeZoneContext);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function listJsonlFiles(rootDir) {
  const out = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(filePath);
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listCodexSessionFiles(baseDir) {
  const rolloutFiles = await listRolloutFiles(baseDir).catch(() => []);
  const allJsonlFiles = listJsonlFiles(baseDir);
  if (allJsonlFiles.length === 0) return rolloutFiles;
  if (rolloutFiles.length === 0) return allJsonlFiles;

  const merged = new Set(rolloutFiles);
  for (const filePath of allJsonlFiles) merged.add(filePath);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Token count extraction
// ---------------------------------------------------------------------------

function extractTokenCount(obj) {
  const payload = obj?.payload;
  if (!payload || obj?.type !== "event_msg") return null;
  if (payload.type === "token_count") {
    return { info: payload.info || null, timestamp: obj?.timestamp || null };
  }
  const msg = payload.msg;
  if (msg && msg.type === "token_count") {
    return { info: msg.info || null, timestamp: obj?.timestamp || null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool name helpers
// ---------------------------------------------------------------------------

function normalizeToolName(payload) {
  const name = payload?.name || "";
  const ns = payload?.namespace || null;
  if (ns && typeof ns === "string" && ns.startsWith("mcp__")) return `${ns}${name}`;
  return name || "unknown";
}

function extractSkillNameFromFunctionCall(payload) {
  if (!payload || payload.name !== "exec_command") return null;
  const args = safeJsonParse(payload.arguments || "{}") || {};
  const cmd = String(args.cmd || "");
  const match = cmd.match(/(?:^|\/)skills\/(?:\.system\/)?([^/\s]+)\/SKILL\.md\b/);
  return match ? match[1] : null;
}

function formatToolDisplayName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  if (parts.length < 3) return name;
  const server = String(parts[1] || "").replace(/^plugin_/, "").replace(/_/g, "-");
  const tool = parts.slice(2).join("__") || name;
  return server ? `${server}/${tool}` : tool;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(u) {
  const out = {};
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    const n = Number(u?.[k] || 0);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  // Codex reports input inclusive of cached_input_tokens; keep our schema
  // convention: non-cached input and cached input tracked separately.
  out.input_tokens = Math.max(0, out.input_tokens - out.cached_input_tokens);
  out.total_tokens =
    out.input_tokens +
    out.cached_input_tokens +
    out.cache_creation_input_tokens +
    out.output_tokens;
  return out;
}

function totalsReset(curr, prev) {
  const a = Number(curr?.total_tokens);
  const b = Number(prev?.total_tokens);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a < b;
}

function pickDelta(lastUsage, totalUsage, prevTotals) {
  const hasLast = lastUsage && typeof lastUsage === "object";
  const hasTotal = totalUsage && typeof totalUsage === "object";
  const hasPrev = prevTotals && typeof prevTotals === "object";

  if (hasTotal && hasPrev) {
    if (totalsReset(totalUsage, prevTotals)) {
      const resetUsage = hasLast ? lastUsage : totalUsage;
      return normalizeUsage(resetUsage);
    }
    const delta = {};
    for (const k of [
      "input_tokens",
      "cached_input_tokens",
      "cache_creation_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
      "total_tokens",
    ]) {
      const a = Number(totalUsage[k]);
      const b = Number(prevTotals[k]);
      if (Number.isFinite(a) && Number.isFinite(b)) delta[k] = Math.max(0, a - b);
    }
    return normalizeUsage(delta);
  }

  if (hasLast) return normalizeUsage(lastUsage);
  if (hasTotal) return normalizeUsage(totalUsage);
  return null;
}

// ---------------------------------------------------------------------------
// Exec stats helpers (local to parser, not shared)
// ---------------------------------------------------------------------------

function durationBucket(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n < 1000) return "<1s";
  if (n < 10_000) return "1-10s";
  if (n < 60_000) return "10-60s";
  if (n < 300_000) return "1-5m";
  return ">5m";
}

function outputSizeBucket(lines, chars) {
  const l = Number(lines || 0);
  const c = Number(chars || 0);
  if (!l && !c) return "quiet";
  if (l <= 20 && c <= 2_000) return "small";
  if (l <= 200 && c <= 20_000) return "medium";
  if (l <= 1000 && c <= 100_000) return "large";
  return "very_large";
}

function buildToolStatsEntry() {
  return { calls: 0, totals: emptyTotals() };
}

function buildSkillStatsEntry(name) {
  return { name, calls: 0, totals: emptyTotals() };
}

// ---------------------------------------------------------------------------
// Finalize helpers
// ---------------------------------------------------------------------------

function finalizeToolRows(map) {
  return Array.from(map.values())
    .map((row) => {
      const rawName = row.raw_name || row.name;
      return {
        name: formatToolDisplayName(rawName),
        raw_name: rawName,
        calls: row.calls,
        totals: row.totals,
      };
    })
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function finalizeSkillRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      name: row.name,
      calls: row.calls,
      totals: row.totals,
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function finalizeExecRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      name: row.name,
      calls: row.calls,
      failures: row.failures,
      duration_ms: row.duration_ms,
      max_duration_ms: row.max_duration_ms,
      output_chars: row.output_chars,
      output_lines: row.output_lines,
      totals: row.totals,
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

async function parseCodexRolloutFile(filePath, { fromIso, toIso, from = null, to = null, timeZoneContext = null } = {}) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = null;
  let cwd = null;
  let model = null;
  let provider = null;
  let cliVersion = null;

  let prevTotals = null;
  let pendingCalls = []; // response_item function_call payloads since last token_count
  let pendingSkills = [];
  let pendingExecEnds = []; // exec_command_end payloads since last token_count

  const totals = emptyTotals();
  const byTool = new Map(); // tool_name -> {name,calls,totals}
  const bySkill = new Map(); // skill_name -> {name,calls,totals}
  const byExecKind = new Map(); // kind -> stats
  const byExecExit = new Map(); // status:exit -> stats
  const byExecExecutable = new Map(); // executable -> stats
  const byExecCommand = new Map(); // sanitized executable + subcommand -> stats
  const byExecDuration = new Map(); // duration bucket -> stats
  const byExecOutput = new Map(); // output size bucket -> stats

  let turnCount = 0;

  function ensureTool(name) {
    if (!byTool.has(name)) {
      byTool.set(name, { name, ...buildToolStatsEntry() });
    }
    return byTool.get(name);
  }

  function ensureExec(map, key) {
    if (!map.has(key)) map.set(key, { name: key, ...buildExecStatsEntry() });
    return map.get(key);
  }

  function ensureSkill(name) {
    if (!bySkill.has(name)) bySkill.set(name, buildSkillStatsEntry(name));
    return bySkill.get(name);
  }

  function getExecKeys(p) {
    if (!p || typeof p !== "object") return;
    const cmdArr = Array.isArray(p.command) ? p.command : null;
    const cmd = cmdArr && cmdArr.length > 0 ? String(cmdArr[cmdArr.length - 1] || "") : "";
    const kind = p.parsed_cmd?.[0]?.type && p.parsed_cmd[0].type !== "unknown"
      ? p.parsed_cmd[0].type
      : inferExecCommandKind(cmd);

    const status = String(p.status || "unknown");
    const exit = Number.isFinite(Number(p.exit_code)) ? Number(p.exit_code) : null;
    const exitKey = `${status}:${exit === null ? "unknown" : exit}`;

    const dur = p.duration ? Math.round((Number(p.duration.secs || 0) * 1000) + Number(p.duration.nanos || 0) / 1e6) : 0;
    const output = String(p.aggregated_output || p.stdout || "");
    const outputChars = output.length;
    const outputLines = output ? output.split("\n").length : 0;
    return {
      kind,
      exitKey,
      executable: getExecutableName(cmd),
      command: sanitizeCommandSignature(cmd),
      duration: durationBucket(dur),
      output: outputSizeBucket(outputLines, outputChars),
      dur,
      outputChars,
      outputLines,
      failed: status !== "completed" || exit !== 0,
    };
  }

  function absorbExecStats(map, key, details) {
    const row = ensureExec(map, key);
    row.calls += 1;
    row.duration_ms += details.dur;
    row.max_duration_ms = Math.max(row.max_duration_ms, details.dur);
    row.output_chars += details.outputChars;
    row.output_lines += details.outputLines;
    if (details.failed) row.failures += 1;
  }

  function absorbExecEnd(p) {
    const details = getExecKeys(p);
    if (!details) return;
    absorbExecStats(byExecKind, details.kind, details);
    absorbExecStats(byExecExit, details.exitKey, details);
    absorbExecStats(byExecExecutable, details.executable, details);
    absorbExecStats(byExecCommand, details.command, details);
    absorbExecStats(byExecDuration, details.duration, details);
    absorbExecStats(byExecOutput, details.output, details);
  }

  function attributeTurn(delta) {
    if (!delta || delta.total_tokens <= 0) return;
    turnCount += 1;

    const toolNames = pendingCalls
      .map((c) => normalizeToolName(c))
      .filter(Boolean);
    const unique = [...new Set(toolNames)];
    const tools = unique.length > 0 ? unique : ["text_response"];
    const share = 1 / tools.length;

    for (const name of tools) {
      const row = ensureTool(name);
      row.calls += share;
      addInto(row.totals, {
        input_tokens: delta.input_tokens * share,
        cached_input_tokens: delta.cached_input_tokens * share,
        cache_creation_input_tokens: delta.cache_creation_input_tokens * share,
        output_tokens: delta.output_tokens * share,
        reasoning_output_tokens: delta.reasoning_output_tokens * share,
        total_tokens: delta.total_tokens * share,
      });
    }

    const uniqueSkills = [...new Set(pendingSkills.filter(Boolean))];
    if (uniqueSkills.length > 0) {
      const skillShare = 1 / uniqueSkills.length;
      for (const name of uniqueSkills) {
        const row = ensureSkill(name);
        row.calls += skillShare;
        addInto(row.totals, {
          input_tokens: delta.input_tokens * skillShare,
          cached_input_tokens: delta.cached_input_tokens * skillShare,
          cache_creation_input_tokens: delta.cache_creation_input_tokens * skillShare,
          output_tokens: delta.output_tokens * skillShare,
          reasoning_output_tokens: delta.reasoning_output_tokens * skillShare,
          total_tokens: delta.total_tokens * skillShare,
        });
      }
    }

    // Attribute exec_command_end rows to exec stats; note these are not a
    // token source — we attach the same tool-shared delta to the command
    // classifier so users can find high-cost command families.
    const execToolShare = tools.includes("exec_command") ? (1 / tools.length) : 0;
    const execDelta = execToolShare > 0 ? {
      input_tokens: delta.input_tokens * execToolShare,
      cached_input_tokens: delta.cached_input_tokens * execToolShare,
      cache_creation_input_tokens: delta.cache_creation_input_tokens * execToolShare,
      output_tokens: delta.output_tokens * execToolShare,
      reasoning_output_tokens: delta.reasoning_output_tokens * execToolShare,
      total_tokens: delta.total_tokens * execToolShare,
    } : null;

    if (execDelta && pendingExecEnds.length > 0) {
      const perExecShare = 1 / pendingExecEnds.length;
      for (const p of pendingExecEnds) {
        const details = getExecKeys(p);
        if (!details) continue;
        const attributed = {
          input_tokens: execDelta.input_tokens * perExecShare,
          cached_input_tokens: execDelta.cached_input_tokens * perExecShare,
          cache_creation_input_tokens: execDelta.cache_creation_input_tokens * perExecShare,
          output_tokens: execDelta.output_tokens * perExecShare,
          reasoning_output_tokens: execDelta.reasoning_output_tokens * perExecShare,
          total_tokens: execDelta.total_tokens * perExecShare,
        };

        addInto(ensureExec(byExecKind, details.kind).totals, attributed);
        addInto(ensureExec(byExecExit, details.exitKey).totals, attributed);
        addInto(ensureExec(byExecExecutable, details.executable).totals, attributed);
        addInto(ensureExec(byExecCommand, details.command).totals, attributed);
        addInto(ensureExec(byExecDuration, details.duration).totals, attributed);
        addInto(ensureExec(byExecOutput, details.output).totals, attributed);

        absorbExecEnd(p);
      }
    } else {
      // Still ingest exec end stats without token attribution so the drill-down works.
      for (const p of pendingExecEnds) absorbExecEnd(p);
    }

    addInto(totals, delta);
    pendingCalls = [];
    pendingSkills = [];
    pendingExecEnds = [];
  }

  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!ts) continue;
    if (fromIso && ts < fromIso) continue;
    if (toIso && ts > toIso) continue;
    if (!isTimestampInRequestedDayRange(ts, { from, to, timeZoneContext })) continue;

    if (obj.type === "session_meta") {
      const p = obj.payload || {};
      sessionId = p.id || sessionId;
      cwd = p.cwd || cwd;
      cliVersion = p.cli_version || cliVersion;
      provider = p.model_provider || provider;
    }

    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.model === "string") model = p.model;
      continue;
    }

    if (obj.type === "response_item" && obj.payload?.type === "function_call") {
      pendingCalls.push(obj.payload);
      const skill = extractSkillNameFromFunctionCall(obj.payload);
      if (skill) pendingSkills.push(skill);
      continue;
    }

    if (obj.type === "event_msg" && obj.payload?.type === "exec_command_end") {
      pendingExecEnds.push(obj.payload);
      continue;
    }

    const tokenCount = extractTokenCount(obj);
    if (tokenCount) {
      const info = tokenCount.info;
      const lastUsage = info?.last_token_usage;
      const totalUsage = info?.total_token_usage;
      const delta = pickDelta(lastUsage, totalUsage, prevTotals);
      if (totalUsage && typeof totalUsage === "object") prevTotals = totalUsage;
      if (delta) attributeTurn(delta);
      continue;
    }
  }

  rl.close();
  stream.close?.();

  return {
    sessionId,
    cwd,
    model: model || provider,
    provider,
    version: cliVersion,
    filePath,
    turnCount,
    totals,
    toolBreakdown: {
      tool_rows: finalizeToolRows(byTool),
    },
    skillsBreakdown: {
      skill_rows: finalizeSkillRows(bySkill),
    },
    execCommandBreakdown: {
      byType: finalizeExecRows(byExecKind),
      byExit: finalizeExecRows(byExecExit),
      byExecutable: finalizeExecRows(byExecExecutable),
      byCommand: finalizeExecRows(byExecCommand),
      byDuration: finalizeExecRows(byExecDuration),
      byOutput: finalizeExecRows(byExecOutput),
    },
  };
}

module.exports = {
  parseCodexRolloutFile,
  extractTokenCount,
  extractSkillNameFromFunctionCall,
  formatToolDisplayName,
  normalizeToolName,
  pickDelta,
  normalizeUsage,
  totalsReset,
  listJsonlFiles,
  listCodexSessionFiles,
  safeJsonParse,
  dayKeyToIsoBounds,
  formatPartsDayKey,
  getZonedParts,
  timestampDayKey,
  isTimestampInRequestedDayRange,
  finalizeToolRows,
  finalizeSkillRows,
  finalizeExecRows,
  buildSkillStatsEntry,
};
