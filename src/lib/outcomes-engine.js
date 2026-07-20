"use strict";

// ---------------------------------------------------------------------------
// Quality-per-dollar / Effective-Tokens engine (opt-in, sidecar)
//
// TokenTracker answers "what did the tokens COST?". This optional layer adds
// "what did they BUY?" by joining an opt-in, vendor-neutral `outcomes.jsonl`
// sidecar to the existing token/$ rows by model + time.
//
// Design invariants (see GitHub #229):
//   1. SIDECAR, never the hot path. This module only ever READS its own file
//      and the already-parsed queue rows. It never touches queue.jsonl, its
//      schema, or the sync path. A bug here cannot corrupt token/$ data.
//   2. DEGRADES TO COST-ONLY. No outcomes file -> readOutcomesData returns []
//      and every join yields empty, so callers render exactly as today.
//   3. METADATA-ONLY. sanitizeOutcome whitelists a tiny set of scalar fields
//      and drops everything else, so a mis-populated sidecar can NEVER surface
//      PR bodies, diffs, or message text into the dashboard.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeRowCost } = require("./pricing");

function resolveOutcomesPath() {
  return path.join(os.homedir(), ".tokentracker", "tracker", "outcomes.jsonl");
}

function resolveAutoOutcomesPath() {
  return path.join(os.homedir(), ".tokentracker", "tracker", "auto-outcomes.jsonl");
}

// The ONLY fields ever lifted off an outcome record. Anything not on this list
// — bodies, diffs, messages, arbitrary blobs — is dropped at read time. This is
// the enforcement point for the metadata-only privacy invariant.
function sanitizeOutcome(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp.trim() : "";
  if (!timestamp) return null; // an outcome with no time can't be joined to $ rows

  // `accepted` is the gate signal: a merged PR / passed task. Strictly boolean
  // — anything other than literal true counts as not-accepted (rework).
  const accepted = raw.accepted === true;

  const model =
    typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "unknown";
  // `tool` mirrors the queue row's `source` (claude, codex, cursor, …). Accept
  // either key so writers can use whichever they have on hand.
  const toolRaw =
    (typeof raw.tool === "string" && raw.tool.trim() && raw.tool) ||
    (typeof raw.source === "string" && raw.source.trim() && raw.source) ||
    "";
  const tool = toolRaw ? String(toolRaw).trim() : "unknown";

  const out = { timestamp, model, tool, accepted };
  // task_type is an optional, low-cardinality label (e.g. "feature", "bugfix").
  if (typeof raw.task_type === "string" && raw.task_type.trim()) {
    out.task_type = raw.task_type.trim();
  }
  for (const key of ["status", "session_hash", "commit_hash", "confidence", "methodology"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim();
  }
  if (Number.isFinite(Number(raw.parent_count))) out.parent_count = Number(raw.parent_count);
  return out;
}

function readOutcomesData(outcomesPath) {
  let raw;
  try {
    raw = fs.readFileSync(outcomesPath, "utf8");
  } catch (e) {
    // ENOENT is the normal "user hasn't opted in" case — silent. Anything else
    // is surfaced once so a genuinely unreadable file isn't hidden forever.
    if (e && e.code !== "ENOENT") {
      console.error("[outcomes] read failed:", (e && e.message) || e);
    }
    return [];
  }
  const out = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    const rec = sanitizeOutcome(parsed);
    if (rec) out.push(rec);
    else malformed += 1;
  }
  if (malformed > 0) {
    console.error(`[outcomes] skipped ${malformed} malformed/invalid line(s) in ${outcomesPath}`);
  }
  return out;
}

function readAllOutcomesData(paths = [resolveOutcomesPath(), resolveAutoOutcomesPath()]) {
  const dedup = new Map();
  for (const outcomePath of paths) {
    for (const row of readOutcomesData(outcomePath)) {
      const key = row.commit_hash
        ? `commit:${row.commit_hash}`
        : `${row.timestamp}|${row.model}|${row.tool}|${row.task_type || ""}`;
      dedup.set(key, row);
    }
  }
  return [...dedup.values()];
}

function dayOf(value) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function inWindow(dayStr, from, to) {
  if (from && dayStr && dayStr < from) return false;
  if (to && dayStr && dayStr > to) return false;
  return true;
}

function bumpCost(map, key, cost, tokens) {
  let agg = map.get(key);
  if (!agg) {
    agg = { cost_usd: 0, total_tokens: 0 };
    map.set(key, agg);
  }
  agg.cost_usd += cost;
  agg.total_tokens += tokens;
}

function bumpOutcome(map, key, accepted) {
  let agg = map.get(key);
  if (!agg) {
    agg = { accepted: 0, outcomes: 0 };
    map.set(key, agg);
  }
  agg.outcomes += 1;
  if (accepted) agg.accepted += 1;
}

function combineRow(key, cost, out) {
  const cost_usd = cost ? cost.cost_usd : 0;
  const total_tokens = cost ? cost.total_tokens : 0;
  const accepted = out ? out.accepted : 0;
  const outcomes = out ? out.outcomes : 0;
  const acceptance_rate = outcomes > 0 ? accepted / outcomes : null;
  // quality per dollar = accepted, gate-passing outcomes ÷ dollars spent.
  // Null (not zero) when we can't form the ratio — no spend or no outcomes —
  // so the UI can distinguish "0 quality" from "not enough data".
  const quality_per_dollar = cost_usd > 0 && outcomes > 0 ? accepted / cost_usd : null;
  // Effective Tokens: the share of tokens that produced accepted work.
  const effective_tokens = acceptance_rate === null ? null : total_tokens * acceptance_rate;
  const effective_cost_usd = acceptance_rate === null ? null : cost_usd * acceptance_rate;
  return {
    key,
    cost_usd,
    total_tokens,
    accepted,
    outcomes,
    acceptance_rate,
    quality_per_dollar,
    effective_tokens,
    effective_cost_usd,
  };
}

function combine(costMap, outMap) {
  const keys = new Set([...costMap.keys(), ...outMap.keys()]);
  const rows = [];
  for (const key of keys) {
    rows.push(combineRow(key, costMap.get(key), outMap.get(key)));
  }
  // Highest quality-per-dollar first; rows without a ratio sink to the bottom.
  rows.sort((a, b) => {
    const av = a.quality_per_dollar;
    const bv = b.quality_per_dollar;
    if (av === null && bv === null) return b.outcomes - a.outcomes;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
  return rows;
}

/**
 * Join outcomes to token/$ rows by model + tool, within an optional [from,to]
 * day window. Returns per-model and per-tool quality-per-dollar / ET, plus
 * totals. Pure: no I/O, no mutation of inputs.
 *
 * @param {Array} queueRows  already-parsed queue rows ({ source, model, hour_start, …token fields })
 * @param {Array} outcomes   sanitized outcome records (from readOutcomesData)
 * @param {{from?:string,to?:string}} [window]
 */
function computeQualityPerDollar(queueRows, outcomes, { from = "", to = "" } = {}) {
  const modelCost = new Map();
  const toolCost = new Map();
  for (const row of queueRows || []) {
    if (!row || typeof row !== "object") continue; // tolerate a stray null/garbage line
    const day = dayOf(row.hour_start);
    if ((from || to) && !inWindow(day, from, to)) continue;
    const model = (row && row.model) || "unknown";
    const tool = (row && row.source) || "unknown";
    const cost = computeRowCost(row) || 0;
    const tokens = Number((row && row.total_tokens) || 0);
    bumpCost(modelCost, model, cost, tokens);
    bumpCost(toolCost, tool, cost, tokens);
  }

  const modelOut = new Map();
  const toolOut = new Map();
  for (const o of outcomes || []) {
    const day = dayOf(o && o.timestamp);
    if ((from || to) && !inWindow(day, from, to)) continue;
    bumpOutcome(modelOut, (o && o.model) || "unknown", !!(o && o.accepted));
    bumpOutcome(toolOut, (o && o.tool) || "unknown", !!(o && o.accepted));
  }

  const by_model = combine(modelCost, modelOut);
  const by_tool = combine(toolCost, toolOut);

  let totalCost = 0;
  let totalTokens = 0;
  for (const v of modelCost.values()) {
    totalCost += v.cost_usd;
    totalTokens += v.total_tokens;
  }
  let totalAccepted = 0;
  let totalOutcomes = 0;
  for (const v of modelOut.values()) {
    totalAccepted += v.accepted;
    totalOutcomes += v.outcomes;
  }
  const totals = combineRow(
    "__all__",
    { cost_usd: totalCost, total_tokens: totalTokens },
    { accepted: totalAccepted, outcomes: totalOutcomes },
  );

  return { available: outcomes && outcomes.length > 0, by_model, by_tool, totals };
}

module.exports = {
  resolveOutcomesPath,
  resolveAutoOutcomesPath,
  sanitizeOutcome,
  readOutcomesData,
  readAllOutcomesData,
  computeQualityPerDollar,
};
