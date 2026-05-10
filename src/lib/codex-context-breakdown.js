// Codex CLI "Context Breakdown" — tool-oriented view.
//
// Privacy commitment: tokens + timestamps only. We do not return prompt text,
// assistant text, tool outputs, file contents, or exec_command arguments.
//
// Data source: ~/.codex/sessions/**/rollout-*.jsonl
// We treat each token_count event as the authoritative delta and attribute
// that delta to "turn" activity since the last token_count. Tool attribution
// is heuristic: delta is split evenly across tools used in that turn.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  emptyTotals,
  addInto,
  roundTotals,
  buildExecStatsEntry,
  allocateByLargestRemainder,
  categorizeTool,
} = require("./categorizer-utils");

const {
  parseCodexRolloutFile,
  listCodexSessionFiles,
  dayKeyToIsoBounds,
  finalizeToolRows,
  finalizeSkillRows,
  finalizeExecRows,
  buildSkillStatsEntry,
} = require("./codex-rollout-parser");

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeRollupTotals(target, add) {
  addInto(target, add);
}

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
    mergeRollupTotals(cur.totals, row.totals || {});
  }
}

function mergeSkillRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    if (!name) continue;
    if (!map.has(name)) map.set(name, buildSkillStatsEntry(name));
    const cur = map.get(name);
    cur.calls += Number(row.calls || 0);
    mergeRollupTotals(cur.totals, row.totals || {});
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
    mergeRollupTotals(cur.totals, row.totals || {});
  }
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

function normalizePeriod(period) {
  const p = String(period || "").trim().toLowerCase();
  if (!p) return null;
  if (["day", "week", "month", "total"].includes(p)) return p;
  return null;
}

function buildDateRange({ period, date }) {
  const anchor = date ? new Date(`${date}T00:00:00Z`) : new Date();
  if (!Number.isFinite(anchor.getTime())) return null;
  const end = new Date(`${anchor.toISOString().slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(end.getTime())) return null;

  let start;
  if (period === "day") start = new Date(`${anchor.toISOString().slice(0, 10)}T00:00:00Z`);
  else if (period === "week") start = new Date(end.getTime() - 6 * 86400_000);
  else if (period === "month") start = new Date(end.getTime() - 29 * 86400_000);
  else if (period === "total") start = null;
  else return null;

  return {
    from: start ? start.toISOString().slice(0, 10) : null,
    to: end.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_SCHEMA_VERSION = "codex-context-v2";

function maxMtimeMs(files) {
  let max = 0;
  for (const filePath of files) {
    try {
      const st = fs.statSync(filePath);
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {}
  }
  return max;
}

function cacheTimeZoneKey(timeZoneContext) {
  if (!timeZoneContext) return "";
  return `${timeZoneContext.timeZone || ""}|${Number.isFinite(timeZoneContext.offsetMinutes) ? timeZoneContext.offsetMinutes : ""}`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function computeCodexContextBreakdown({
  from = null,
  to = null,
  period = null,
  date = null,
  codexDir = null,
  top = 20,
  timeZoneContext = null,
} = {}) {
  let fromKey = from;
  let toKey = to;
  if ((!fromKey && !toKey) && normalizePeriod(period)) {
    const range = buildDateRange({ period: normalizePeriod(period), date });
    fromKey = range?.from || null;
    toKey = range?.to || null;
  }

  const { fromIso, toIso } = dayKeyToIsoBounds(fromKey, toKey);
  const baseDir = codexDir || path.join(os.homedir(), ".codex", "sessions");

  const files = await listCodexSessionFiles(baseDir);
  const cacheKey = [
    CACHE_SCHEMA_VERSION,
    baseDir,
    fromKey || "",
    toKey || "",
    cacheTimeZoneKey(timeZoneContext),
    Number.isFinite(top) ? top : 20,
    files.length,
    maxMtimeMs(files),
  ].join("|");
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const sessions = [];

  for (const filePath of files) {
    const parsed = await parseCodexRolloutFile(filePath, {
      fromIso,
      toIso,
      from: fromKey,
      to: toKey,
      timeZoneContext,
    });
    if (!parsed || !parsed.totals || !parsed.totals.total_tokens) continue;
    sessions.push(parsed);
  }

  const grand = emptyTotals();
  const byTool = new Map();
  const bySkill = new Map();
  const byExecType = new Map();
  const byExecExit = new Map();
  const byExecExecutable = new Map();
  const byExecCommand = new Map();
  const byExecDuration = new Map();
  const byExecOutput = new Map();

  for (const s of sessions) {
    mergeRollupTotals(grand, s.totals);
    mergeRows(byTool, s.toolBreakdown?.tool_rows);
    mergeSkillRows(bySkill, s.skillsBreakdown?.skill_rows);
    mergeExecRows(byExecType, s.execCommandBreakdown?.byType);
    mergeExecRows(byExecExit, s.execCommandBreakdown?.byExit);
    mergeExecRows(byExecExecutable, s.execCommandBreakdown?.byExecutable);
    mergeExecRows(byExecCommand, s.execCommandBreakdown?.byCommand);
    mergeExecRows(byExecDuration, s.execCommandBreakdown?.byDuration);
    mergeExecRows(byExecOutput, s.execCommandBreakdown?.byOutput);
  }

  const toolRows = finalizeToolRows(new Map([...byTool.entries()].map(([k, v]) => [k, v])));
  const skillRows = finalizeSkillRows(new Map([...bySkill.entries()].map(([k, v]) => [k, v])));
  const execTypeRows = finalizeExecRows(new Map([...byExecType.entries()].map(([k, v]) => [k, v])));
  const execExitRows = finalizeExecRows(new Map([...byExecExit.entries()].map(([k, v]) => [k, v])));
  const execExecutableRows = finalizeExecRows(new Map([...byExecExecutable.entries()].map(([k, v]) => [k, v])));
  const execCommandRows = finalizeExecRows(new Map([...byExecCommand.entries()].map(([k, v]) => [k, v])));
  const execDurationRows = finalizeExecRows(new Map([...byExecDuration.entries()].map(([k, v]) => [k, v])));
  const execOutputRows = finalizeExecRows(new Map([...byExecOutput.entries()].map(([k, v]) => [k, v])));
  const limitedTop = Number.isFinite(top) ? top : 20;
  const toolRowsLimited = toolRows.slice(0, limitedTop).map((r) => ({
    name: r.name,
    calls: Math.round(r.calls || 0),
    totals: roundTotals(r.totals),
  }));
  const skillRowsLimited = skillRows.slice(0, limitedTop).map((r) => ({
    name: r.name,
    calls: Math.round(r.calls || 0),
    totals: roundTotals(r.totals),
  }));

  const byCategory = new Map(); // category -> {name,calls,totals,tools:Map}
  for (const row of toolRows) {
    const cat = categorizeTool(row.raw_name || row.name);
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { name: cat, calls: 0, totals: emptyTotals(), tools: new Map() });
    }
    const target = byCategory.get(cat);
    target.calls += row.calls || 0;
    mergeRollupTotals(target.totals, row.totals || {});
    target.tools.set(row.raw_name || row.name, row);
  }
  const categoryRows = Array.from(byCategory.values())
    .map((c) => ({
      name: c.name,
      calls: Math.round(c.calls || 0),
      totals: roundTotals(c.totals),
      tools: finalizeToolRows(new Map([...c.tools.entries()].map(([k, v]) => [k, v])))
        .slice(0, limitedTop)
        .map((r) => ({
          name: r.name,
          calls: Math.round(r.calls || 0),
          totals: roundTotals(r.totals),
        })),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  const nonTextToolTotal = toolRows.reduce((sum, row) => {
    if ((row.raw_name || row.name) === "text_response") return sum;
    return sum + Number(row.totals?.total_tokens || 0);
  }, 0);
  const displayedMessageTotal = Math.max(
    0,
    Number(grand.total_tokens || 0) - Number(grand.reasoning_output_tokens || 0) - nonTextToolTotal,
  );
  const textResponse = toolRows.find((row) => (row.raw_name || row.name) === "text_response");
  const textResponseTotals = textResponse?.totals || emptyTotals();
  const textResponseHistoryWeight = Math.max(
    0,
    Number(textResponseTotals.cached_input_tokens || 0) + Number(textResponseTotals.cache_creation_input_tokens || 0),
  );
  const messageAlloc = allocateByLargestRemainder(
    displayedMessageTotal,
    {
      user_input: Math.max(0, Number(textResponseTotals.input_tokens || 0)),
      conversation_history: textResponseHistoryWeight,
      assistant_response: Math.max(0, Number(textResponseTotals.output_tokens || 0)),
    },
    ["user_input", "conversation_history", "assistant_response"],
  );
  const historyAlloc = allocateByLargestRemainder(
    messageAlloc.conversation_history || 0,
    {
      cached_input_tokens: Math.max(0, Number(textResponseTotals.cached_input_tokens || 0)),
      cache_creation_input_tokens: Math.max(0, Number(textResponseTotals.cache_creation_input_tokens || 0)),
    },
    ["cached_input_tokens", "cache_creation_input_tokens"],
  );
  const textResponseInput = messageAlloc.user_input || 0;
  const textResponseHistory = messageAlloc.conversation_history || 0;
  const textResponseOutput = messageAlloc.assistant_response || 0;
  const messageBreakdown = [
    {
      key: "user_input",
      name: "User input",
      totals: roundTotals({
        input_tokens: textResponseInput,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: textResponseInput,
      }),
    },
    {
      key: "conversation_history",
      name: "Conversation history",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: historyAlloc.cached_input_tokens || 0,
        cache_creation_input_tokens: historyAlloc.cache_creation_input_tokens || 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: textResponseHistory,
      }),
    },
    {
      key: "assistant_response",
      name: "Assistant response",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: textResponseOutput,
        reasoning_output_tokens: 0,
        total_tokens: textResponseOutput,
      }),
    },
  ].sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  const serializeExecRows = (rows) => rows.slice(0, limitedTop).map((r) => ({
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
    source: "codex",
    scope: "supported",
    breakdown_status: "ok",
    totals: grand,
    session_count: sessions.length,
    message_count: sessions.reduce((a, s) => a + (s.turnCount || 0), 0),
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
      total_calls: Math.round(skillRows.reduce((a, r) => a + Number(r.calls || 0), 0)),
      skills: skillRowsLimited,
      privacy: {
        includes_inputs: false,
        note: "Codex skill use is inferred from exec_command reads of SKILL.md; command arguments are not returned.",
      },
    },
    exec_command_breakdown: {
      by_type: serializeExecRows(execTypeRows),
      by_executable: serializeExecRows(execExecutableRows),
      by_command: serializeExecRows(execCommandRows),
      by_duration: serializeExecRows(execDurationRows),
      by_output: serializeExecRows(execOutputRows),
      by_exit: serializeExecRows(execExitRows),
    },
  };

  CACHE.set(cacheKey, { at: Date.now(), value: result });
  while (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return result;
}

module.exports = {
  computeCodexContextBreakdown,
};
