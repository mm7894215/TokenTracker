// Grok Build "Context Breakdown" — Codex-style tool-oriented view.
//
// Privacy: tokens + timestamps + tool names only. Never return prompt text,
// assistant text, tool arguments, or file contents.
//
// Data source: ~/.grok/sessions/**/updates.jsonl
// Authoritative billable totals come from turn_completed.usage. Tool/exec
// attribution is heuristic: the turn's non-reasoning tokens are split evenly
// across tools observed in that turn (same approach as Codex).

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const {
  emptyTotals,
  addInto,
  roundTotals,
  buildExecStatsEntry,
  categorizeTool,
  inferExecCommandKind,
  sanitizeCommandSignature,
  getExecutableName,
} = require("./categorizer-utils");

const CACHE_SCHEMA_VERSION = "grok-context-v2";
const CACHE = new Map();
// Result-level TTL. Per-file parse cache is the main win when flipping tabs.
const CACHE_TTL_MS = 5 * 60_000;
// Deduplicate concurrent scans when the dashboard remounts the panel quickly.
const IN_FLIGHT = new Map();
// Per updates.jsonl parse cache — mirrors Codex PARSED_GROUP_CACHE so switching
// back to Grok does not re-read every session log on each open.
const FILE_PARSE_CACHE = new Map();
const MAX_FILE_PARSE_CACHE_ENTRIES = 512;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function dayKeyToIsoBounds(from, to) {
  if (!from && !to) return { fromIso: null, toIso: null };
  const fromDate = from ? new Date(`${from}T00:00:00Z`) : null;
  const toDate = to ? new Date(`${to}T23:59:59Z`) : null;
  if (fromDate && Number.isFinite(fromDate.getTime())) {
    fromDate.setUTCHours(fromDate.getUTCHours() - 14);
  }
  if (toDate && Number.isFinite(toDate.getTime())) {
    toDate.setUTCHours(toDate.getUTCHours() + 14);
  }
  return {
    fromIso: fromDate ? fromDate.toISOString() : null,
    toIso: toDate ? toDate.toISOString() : null,
  };
}

function timestampToIso(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const dt = new Date(millis);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) return timestampToIso(Number(trimmed));
    const dt = new Date(trimmed);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  return null;
}

function dayKeyFromIso(iso, timeZoneContext) {
  if (!iso) return "";
  const { timeZone, offsetMinutes } = timeZoneContext || {};
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return iso.slice(0, 10);

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hourCycle: "h23",
      }).formatToParts(dt);
      const values = {};
      for (const part of parts) {
        if (part.type !== "literal") values[part.type] = part.value;
      }
      if (values.year && values.month && values.day) {
        return `${values.year}-${values.month}-${values.day}`;
      }
    } catch {
      // fall through
    }
  }
  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() - Number(offsetMinutes) * 60_000);
    return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
  }
  return iso.slice(0, 10);
}

function isIsoInRange(iso, { from, to, timeZoneContext } = {}) {
  if (!from && !to) return true;
  const day = dayKeyFromIso(iso, timeZoneContext);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Grok path discovery
// ---------------------------------------------------------------------------

function resolveGrokHome(env = process.env) {
  if (env.TOKENTRACKER_GROK_HOME) return env.TOKENTRACKER_GROK_HOME;
  if (env.GROK_HOME) return env.GROK_HOME;
  return path.join(os.homedir(), ".grok");
}

function discoverGrokSessionFiles(env = process.env) {
  const home = resolveGrokHome(env);
  const sessionsRoot = path.join(home, "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];

  const out = [];
  let cwdDirs = [];
  try {
    cwdDirs = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }

  for (const cwdDir of cwdDirs) {
    const cwdPath = path.join(sessionsRoot, cwdDir);
    let st;
    try {
      st = fs.statSync(cwdPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let sessionIds = [];
    try {
      sessionIds = fs.readdirSync(cwdPath);
    } catch {
      continue;
    }

    for (const sid of sessionIds) {
      const sessionDir = path.join(cwdPath, sid);
      const updatesPath = path.join(sessionDir, "updates.jsonl");
      let ust;
      try {
        ust = fs.statSync(updatesPath);
      } catch {
        continue;
      }
      if (!ust.isFile() || ust.size <= 0) continue;
      out.push({
        sessionId: sid,
        sessionDir,
        updatesPath,
        mtimeMs: ust.mtimeMs,
        size: ust.size,
      });
    }
  }
  out.sort((a, b) => a.updatesPath.localeCompare(b.updatesPath));
  return out;
}

// ---------------------------------------------------------------------------
// Tool / exec naming
// ---------------------------------------------------------------------------

function mapGrokToolName(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return "unknown";
  const lower = name.toLowerCase();
  if (lower === "read_file" || lower === "read") return "Read";
  if (lower === "write" || lower === "write_file") return "Write";
  if (lower === "search_replace" || lower === "str_replace" || lower === "edit") return "Edit";
  if (lower === "grep") return "Grep";
  if (lower === "list_dir" || lower === "glob" || lower === "find") return "Glob";
  if (lower === "run_terminal_command" || lower === "bash" || lower === "shell") return "Bash";
  if (lower === "todo_write" || lower === "todowrite") return "TodoWrite";
  if (lower === "web_search" || lower === "websearch") return "WebSearch";
  if (lower === "web_fetch" || lower === "webfetch") return "WebFetch";
  if (lower.startsWith("mcp_") || lower.startsWith("mcp-")) {
    return name.replace(/^mcp[_-]/i, "mcp__").replace(/-/g, "_");
  }
  return name;
}

function extractToolName(update, meta) {
  const fromMetaTool =
    update?._meta?.["x.ai/tool"]?.name ||
    update?._meta?.["x.ai/tool"]?.label ||
    null;
  const fromUpdateParams = meta?.updateParams?.title || meta?.updateParams?.name || null;
  const fromUpdate = update?.title || update?.name || null;
  return mapGrokToolName(fromMetaTool || fromUpdateParams || fromUpdate || "unknown");
}

function extractExecCommand(update) {
  const raw = update?.rawInput;
  if (!raw || typeof raw !== "object") return null;
  const command =
    typeof raw.command === "string"
      ? raw.command
      : typeof raw.cmd === "string"
        ? raw.cmd
        : null;
  if (!command || !command.trim()) return null;
  return command.trim();
}

function durationBucket(ms) {
  const n = Number(ms || 0);
  if (n < 100) return "<100ms";
  if (n < 500) return "100-500ms";
  if (n < 2000) return "0.5-2s";
  if (n < 10000) return "2-10s";
  if (n < 60000) return "10-60s";
  return ">=60s";
}

function outputSizeBucket(lines, chars) {
  if (lines >= 500 || chars >= 50_000) return "huge";
  if (lines >= 100 || chars >= 10_000) return "large";
  if (lines >= 20 || chars >= 2_000) return "medium";
  if (lines > 0 || chars > 0) return "small";
  return "empty";
}

function readUsageTotals(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputRaw = Math.max(0, Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0);
  const cached = Math.max(
    0,
    Number(usage.cachedReadTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0) || 0,
  );
  const output = Math.max(0, Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0);
  const reasoning = Math.max(
    0,
    Number(usage.reasoningTokens ?? usage.reasoning_output_tokens ?? 0) || 0,
  );
  const nonCachedInput = Math.max(0, inputRaw - cached);
  // Prefer the reported totalTokens (authoritative billable total). Fallback
  // includes reasoning so a missing total still matches usage-parser shape.
  let total = Math.max(0, Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0);
  if (total <= 0) total = nonCachedInput + cached + output + reasoning;
  if (total <= 0) return null;
  return {
    input_tokens: nonCachedInput,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

// ---------------------------------------------------------------------------
// Per-session parse
// ---------------------------------------------------------------------------

function ensureTool(map, name) {
  if (!map.has(name)) map.set(name, { name, raw_name: name, calls: 0, totals: emptyTotals() });
  return map.get(name);
}

function ensureExec(map, key) {
  if (!map.has(key)) map.set(key, { name: key, ...buildExecStatsEntry() });
  return map.get(key);
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

function finalizeToolRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      name: row.name,
      raw_name: row.raw_name || row.name,
      calls: row.calls,
      totals: roundTotals(row.totals),
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
      totals: roundTotals(row.totals),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function fileParseCacheKey(updatesPath, { from, to, timeZoneContext } = {}, stat) {
  return [
    CACHE_SCHEMA_VERSION,
    updatesPath,
    from || "",
    to || "",
    timeZoneContext?.timeZone || "",
    timeZoneContext?.offsetMinutes ?? "",
    Number(stat?.size || 0),
    Math.floor(Number(stat?.mtimeMs || 0)),
  ].join("|");
}

function rememberFileParse(key, value) {
  FILE_PARSE_CACHE.delete(key);
  FILE_PARSE_CACHE.set(key, value);
  while (FILE_PARSE_CACHE.size > MAX_FILE_PARSE_CACHE_ENTRIES) {
    const oldest = FILE_PARSE_CACHE.keys().next().value;
    if (oldest == null) break;
    FILE_PARSE_CACHE.delete(oldest);
  }
}

async function parseGrokUpdatesFile(updatesPath, { from, to, timeZoneContext } = {}) {
  let stat = null;
  try {
    stat = fs.statSync(updatesPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;

  const cacheKey = fileParseCacheKey(updatesPath, { from, to, timeZoneContext }, stat);
  const hit = FILE_PARSE_CACHE.get(cacheKey);
  if (hit) {
    rememberFileParse(cacheKey, hit);
    return hit;
  }

  const byTool = new Map();
  const byExecKind = new Map();
  const byExecExit = new Map();
  const byExecExecutable = new Map();
  const byExecCommand = new Map();
  const byExecDuration = new Map();
  const byExecOutput = new Map();
  const totals = emptyTotals();
  let turnCount = 0;

  // promptId -> { tools: string[], execs: details[], sawThought: bool }
  const turns = new Map();

  function getTurn(key) {
    if (!turns.has(key)) {
      turns.set(key, { tools: [], execs: [], sawThought: false, sawMessage: false });
    }
    return turns.get(key);
  }

  function buildExecDetails(command, status) {
    const kind = inferExecCommandKind(command);
    const failed = String(status || "").toLowerCase() === "failed" || String(status || "").toLowerCase() === "error";
    return {
      kind,
      exitKey: failed ? "failed:unknown" : "completed:0",
      executable: getExecutableName(command),
      command: sanitizeCommandSignature(command),
      duration: durationBucket(0),
      output: outputSizeBucket(0, 0),
      dur: 0,
      outputChars: 0,
      outputLines: 0,
      failed,
    };
  }

  function attributeTurn(delta, turnState) {
    if (!delta || delta.total_tokens <= 0) return;
    turnCount += 1;

    const uniqueTools = [...new Set((turnState?.tools || []).filter(Boolean))];
    const tools = uniqueTools.length > 0 ? uniqueTools : ["text_response"];
    const share = 1 / tools.length;

    for (const name of tools) {
      const row = ensureTool(byTool, name);
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

    // Prefer Bash bucket share when present (Codex attaches exec tokens only to
    // the shell tool's fraction of the turn).
    const bashShare = tools.includes("Bash") ? share : 0;
    const execDelta =
      bashShare > 0
        ? {
            input_tokens: delta.input_tokens * bashShare,
            cached_input_tokens: delta.cached_input_tokens * bashShare,
            cache_creation_input_tokens: delta.cache_creation_input_tokens * bashShare,
            output_tokens: delta.output_tokens * bashShare,
            reasoning_output_tokens: delta.reasoning_output_tokens * bashShare,
            total_tokens: delta.total_tokens * bashShare,
          }
        : null;

    const pendingExecDetails = turnState?.execs || [];
    if (execDelta && pendingExecDetails.length > 0) {
      const per = 1 / pendingExecDetails.length;
      for (const details of pendingExecDetails) {
        const attributed = {
          input_tokens: execDelta.input_tokens * per,
          cached_input_tokens: execDelta.cached_input_tokens * per,
          cache_creation_input_tokens: execDelta.cache_creation_input_tokens * per,
          output_tokens: execDelta.output_tokens * per,
          reasoning_output_tokens: execDelta.reasoning_output_tokens * per,
          total_tokens: execDelta.total_tokens * per,
        };
        addInto(ensureExec(byExecKind, details.kind).totals, attributed);
        addInto(ensureExec(byExecExit, details.exitKey).totals, attributed);
        addInto(ensureExec(byExecExecutable, details.executable).totals, attributed);
        addInto(ensureExec(byExecCommand, details.command).totals, attributed);
        addInto(ensureExec(byExecDuration, details.duration).totals, attributed);
        addInto(ensureExec(byExecOutput, details.output).totals, attributed);
        absorbExecStats(byExecKind, details.kind, details);
        absorbExecStats(byExecExit, details.exitKey, details);
        absorbExecStats(byExecExecutable, details.executable, details);
        absorbExecStats(byExecCommand, details.command, details);
        absorbExecStats(byExecDuration, details.duration, details);
        absorbExecStats(byExecOutput, details.output, details);
      }
    } else {
      for (const details of pendingExecDetails) {
        absorbExecStats(byExecKind, details.kind, details);
        absorbExecStats(byExecExit, details.exitKey, details);
        absorbExecStats(byExecExecutable, details.executable, details);
        absorbExecStats(byExecCommand, details.command, details);
        absorbExecStats(byExecDuration, details.duration, details);
        absorbExecStats(byExecOutput, details.output, details);
      }
    }

    addInto(totals, delta);
  }

  if (!fs.existsSync(updatesPath)) {
    return emptySessionResult();
  }

  const input = fs.createReadStream(updatesPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const params = record?.params || {};
      const meta = params._meta || record?._meta || {};
      const update = params.update;
      if (!update || typeof update !== "object") continue;

      const sessionUpdate = update.sessionUpdate || meta.updateType || "";
      const promptId =
        meta.promptId ||
        update.prompt_id ||
        (meta.turnStartMs != null ? `turn-${meta.turnStartMs}` : null) ||
        "unknown";
      const ts =
        timestampToIso(meta.agentTimestampMs) ||
        timestampToIso(meta.timestampMs) ||
        timestampToIso(record.timestamp) ||
        null;

      if (sessionUpdate === "tool_call" || meta.updateType === "ToolCall") {
        const turn = getTurn(promptId);
        const toolName = extractToolName(update, meta);
        turn.tools.push(toolName);
        if (toolName === "Bash") {
          const cmd = extractExecCommand(update);
          if (cmd) {
            const status = update.status || meta.updateParams?.status || "completed";
            turn.execs.push(buildExecDetails(cmd, status));
          }
        }
        continue;
      }

      if (sessionUpdate === "agent_thought_chunk" || meta.updateType === "AgentThoughtChunk") {
        getTurn(promptId).sawThought = true;
        continue;
      }

      if (
        sessionUpdate === "agent_message_chunk" ||
        sessionUpdate === "user_message_chunk" ||
        meta.updateType === "AgentMessageChunk"
      ) {
        getTurn(promptId).sawMessage = true;
        continue;
      }

      if (sessionUpdate !== "turn_completed") continue;
      if (ts && !isIsoInRange(ts, { from, to, timeZoneContext })) {
        turns.delete(promptId);
        continue;
      }

      const usage = readUsageTotals(update.usage);
      if (!usage) {
        turns.delete(promptId);
        continue;
      }

      // Prefer per-model split when present (sum models into one turn total —
      // already aggregated in usage.totalTokens).
      const turnState = turns.get(promptId) || { tools: [], execs: [], sawThought: false, sawMessage: false };
      attributeTurn(usage, turnState);
      turns.delete(promptId);
    }
  } finally {
    rl.close();
    input.destroy?.();
  }

  const parsedResult = {
    totals: roundTotals(totals),
    turnCount,
    toolBreakdown: { tool_rows: finalizeToolRows(byTool) },
    execCommandBreakdown: {
      by_type: finalizeExecRows(byExecKind),
      by_executable: finalizeExecRows(byExecExecutable),
      by_command: finalizeExecRows(byExecCommand),
      by_duration: finalizeExecRows(byExecDuration),
      by_output: finalizeExecRows(byExecOutput),
      by_exit: finalizeExecRows(byExecExit),
    },
  };
  rememberFileParse(cacheKey, parsedResult);
  return parsedResult;
}

function emptySessionResult() {
  return {
    totals: emptyTotals(),
    turnCount: 0,
    toolBreakdown: { tool_rows: [] },
    execCommandBreakdown: {
      by_type: [],
      by_executable: [],
      by_command: [],
      by_duration: [],
      by_output: [],
      by_exit: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Merge + display assembly (mirrors codex-context-breakdown)
// ---------------------------------------------------------------------------

function mergeRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    const rawName = row?.raw_name ? String(row.raw_name) : name;
    const key = rawName || name;
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { name, raw_name: rawName, calls: 0, totals: emptyTotals() });
    }
    const cur = map.get(key);
    cur.name = name;
    cur.raw_name = rawName;
    cur.calls += Number(row.calls || 0);
    addInto(cur.totals, row.totals || {});
  }
}

function mergeExecRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, ...buildExecStatsEntry() });
    const cur = map.get(name);
    cur.calls += Number(row.calls || 0);
    cur.failures += Number(row.failures || 0);
    cur.duration_ms += Number(row.duration_ms || 0);
    cur.max_duration_ms = Math.max(cur.max_duration_ms, Number(row.max_duration_ms || 0));
    cur.output_chars += Number(row.output_chars || 0);
    cur.output_lines += Number(row.output_lines || 0);
    addInto(cur.totals, row.totals || {});
  }
}

function buildGrokInventorySignature(sessions) {
  return crypto
    .createHash("sha256")
    .update(
      (sessions || [])
        .map((s) => `${s.updatesPath}:${s.size}:${Math.floor(s.mtimeMs)}`)
        .join("|"),
    )
    .digest("hex");
}

function buildGrokResultCacheKey({ from, to, top, timeZoneContext, inventorySig }) {
  // Include inventorySig so a changed session file cannot serve a stale aggregate.
  // Unchanged files still skip re-parse via FILE_PARSE_CACHE (Codex-style).
  return [
    CACHE_SCHEMA_VERSION,
    from || "",
    to || "",
    top,
    timeZoneContext?.timeZone || "",
    timeZoneContext?.offsetMinutes ?? "",
    inventorySig || "",
  ].join("|");
}

async function computeGrokContextBreakdown(options = {}) {
  const {
    from = null,
    to = null,
    top = 50,
    timeZoneContext = null,
    env = process.env,
  } = options;
  const limitedTop = Number.isFinite(top) && top > 0 ? Math.min(Math.floor(top), 200) : 50;
  const sessions = discoverGrokSessionFiles(env);
  const inventorySig = buildGrokInventorySignature(sessions);
  const cacheKey = buildGrokResultCacheKey({
    from,
    to,
    top: limitedTop,
    timeZoneContext,
    inventorySig,
  });

  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const existing = IN_FLIGHT.get(cacheKey);
  if (existing) return existing;

  const run = computeGrokContextBreakdownUncached({
    from,
    to,
    top: limitedTop,
    timeZoneContext,
    env,
    sessions,
    cacheKey,
  });
  IN_FLIGHT.set(cacheKey, run);
  try {
    return await run;
  } finally {
    if (IN_FLIGHT.get(cacheKey) === run) IN_FLIGHT.delete(cacheKey);
  }
}

async function computeGrokContextBreakdownUncached({
  from = null,
  to = null,
  top = 50,
  timeZoneContext = null,
  env = process.env,
  sessions = null,
  cacheKey = null,
} = {}) {
  const limitedTop = Number.isFinite(top) && top > 0 ? Math.min(Math.floor(top), 200) : 50;
  const sessionList = sessions || discoverGrokSessionFiles(env);
  const resultCacheKey =
    cacheKey ||
    buildGrokResultCacheKey({
      from,
      to,
      top: limitedTop,
      timeZoneContext,
      inventorySig: buildGrokInventorySignature(sessionList),
    });

  const grand = emptyTotals();
  const byTool = new Map();
  const byExecKind = new Map();
  const byExecExit = new Map();
  const byExecExecutable = new Map();
  const byExecCommand = new Map();
  const byExecDuration = new Map();
  const byExecOutput = new Map();
  let messageCount = 0;
  let sessionCount = 0;

  for (const sess of sessionList) {
    const parsed = await parseGrokUpdatesFile(sess.updatesPath, {
      from,
      to,
      timeZoneContext,
    });
    if (!parsed?.totals?.total_tokens) continue;
    sessionCount += 1;
    messageCount += Number(parsed.turnCount || 0);
    addInto(grand, parsed.totals);
    mergeRows(byTool, parsed.toolBreakdown?.tool_rows);
    mergeExecRows(byExecKind, parsed.execCommandBreakdown?.by_type);
    mergeExecRows(byExecExecutable, parsed.execCommandBreakdown?.by_executable);
    mergeExecRows(byExecCommand, parsed.execCommandBreakdown?.by_command);
    mergeExecRows(byExecDuration, parsed.execCommandBreakdown?.by_duration);
    mergeExecRows(byExecOutput, parsed.execCommandBreakdown?.by_output);
    mergeExecRows(byExecExit, parsed.execCommandBreakdown?.by_exit);
  }

  const toolRows = finalizeToolRows(byTool);
  const toolRowsLimited = toolRows.slice(0, limitedTop);

  // Category rows from tool names (File Ops / Search / Execution / ...)
  const byCategory = new Map();
  for (const row of toolRows) {
    if (row.name === "text_response") continue;
    const cat = categorizeTool(row.raw_name || row.name);
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { name: cat, calls: 0, totals: emptyTotals(), tools: [] });
    }
    const target = byCategory.get(cat);
    target.calls += Number(row.calls || 0);
    addInto(target.totals, row.totals || {});
    target.tools.push({
      name: row.name,
      calls: row.calls,
      totals: roundTotals(row.totals),
    });
  }
  const categoryRows = Array.from(byCategory.values())
    .map((c) => ({
      name: c.name,
      calls: Math.round(c.calls || 0),
      totals: roundTotals(c.totals),
      tools: (c.tools || [])
        .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0))
        .slice(0, limitedTop),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  // Message breakdown: residual "text_response" tools + reasoning/output split
  const textResponse = toolRows.find((r) => r.name === "text_response");
  const textTotals = textResponse?.totals || emptyTotals();
  const reasoning = Number(grand.reasoning_output_tokens || 0);
  const assistantOut = Math.max(0, Number(grand.output_tokens || 0) - Math.min(reasoning, Number(grand.output_tokens || 0)));
  // For Grok, cached reads dominate conversation history; non-cached input is
  // closer to "current user/context injection". Heuristic only — matches Codex
  // message_breakdown intent without reading message bodies.
  const historyTokens = Number(grand.cached_input_tokens || 0);
  const userish = Number(grand.input_tokens || 0);
  const messageBreakdown = [
    {
      key: "user_input",
      name: "User input",
      totals: roundTotals({
        input_tokens: userish,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: userish,
      }),
    },
    {
      key: "conversation_history",
      name: "Conversation history",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: historyTokens,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: historyTokens,
      }),
    },
    {
      key: "assistant_response",
      name: "Assistant response",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: assistantOut,
        reasoning_output_tokens: 0,
        total_tokens: assistantOut,
      }),
    },
  ].sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  const serializeExecRows = (rows) =>
    (rows || []).slice(0, limitedTop).map((r) => ({
      name: r.name,
      calls: r.calls,
      failures: r.failures,
      duration_ms: r.duration_ms,
      max_duration_ms: r.max_duration_ms,
      output_chars: r.output_chars,
      output_lines: r.output_lines,
      totals: roundTotals(r.totals),
    }));

  const result = {
    source: "grok",
    scope: "supported",
    breakdown_status: "ok",
    totals: roundTotals(grand),
    session_count: sessionCount,
    message_count: messageCount,
    message_breakdown: {
      categories: messageBreakdown,
      privacy: {
        includes_content: false,
        note: "Aggregated message token categories only; prompt and assistant text are never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: Math.round(toolRows.reduce((a, r) => a + Number(r.calls || 0), 0)),
      tools: toolRowsLimited,
      categories: categoryRows.slice(0, limitedTop),
      tools_total: toolRows.reduce((a, r) => a + Math.round(r.totals?.total_tokens || 0), 0),
      privacy: {
        includes_inputs: false,
        note: "Aggregated tool names only; no tool arguments or outputs are included.",
      },
    },
    skills_breakdown: {
      total_calls: 0,
      skills: [],
      privacy: {
        includes_inputs: false,
        note: "Grok Build does not currently expose a dedicated skill usage channel in turn logs.",
      },
    },
    exec_command_breakdown: {
      by_type: serializeExecRows(finalizeExecRows(byExecKind)),
      by_executable: serializeExecRows(finalizeExecRows(byExecExecutable)),
      by_command: serializeExecRows(finalizeExecRows(byExecCommand)),
      by_duration: serializeExecRows(finalizeExecRows(byExecDuration)),
      by_output: serializeExecRows(finalizeExecRows(byExecOutput)),
      by_exit: serializeExecRows(finalizeExecRows(byExecExit)),
    },
  };

  CACHE.set(resultCacheKey, { at: Date.now(), value: result });
  while (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return result;
}

module.exports = {
  computeGrokContextBreakdown,
  // test helpers
  mapGrokToolName,
  readUsageTotals,
  discoverGrokSessionFiles,
  parseGrokUpdatesFile,
};
