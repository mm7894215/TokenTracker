"use strict";

// Metadata-only session analytics sidecar. This scanner deliberately never
// persists prompts, assistant text, tool arguments, command output, or diffs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { listClaudeProjectFiles, listRolloutFilesDeep, claudeMessageDedupKey } = require("./rollout");
const { parseCodexRolloutFile } = require("./codex-rollout-parser");
const { computeRowCost } = require("./pricing");

// Bump the sidecar when derived metrics change so cached rows are rebuilt
// instead of leaving the dashboard on the previous (over-counted) heuristic.
const SIDECAR_VERSION = 6;
const EDIT_TOOLS = new Set(["apply_patch", "edit", "write", "multiedit", "notebookedit"]);
const PLACEHOLDER_MODELS = new Set(["<synthetic>", "synthetic", "<unknown>", "unknown"]);
const CLAUDE_MEM_OBSERVER_PROJECT_SUFFIX = "--claude-mem-observer-sessions";
const CODEX_SUBAGENT_TOOLS = new Set(["spawn_agent", "multi_agent_v1__spawn_agent"]);
const CODEX_SIGNAL_TOOLS = new Set([...EDIT_TOOLS, ...CODEX_SUBAGENT_TOOLS]);

function normalizeSessionModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || PLACEHOLDER_MODELS.has(model.toLowerCase())) return null;
  return model;
}

function resolveSessionSidecarPath(home = os.homedir()) {
  return path.join(home, ".tokentracker", "tracker", "session.queue.jsonl");
}

function sessionHash(source, id) {
  return crypto.createHash("sha256").update(`${source}\0${id || "unknown"}`).digest("hex").slice(0, 24);
}

function finite(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenTotals(usage) {
  const input_tokens = finite(usage?.input_tokens);
  const cached_input_tokens = finite(usage?.cache_read_input_tokens ?? usage?.cached_input_tokens);
  const cache_creation_input_tokens = finite(usage?.cache_creation_input_tokens);
  const output_tokens = finite(usage?.output_tokens);
  const reasoning_output_tokens = finite(usage?.reasoning_output_tokens);
  const total_tokens = input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens;
  return { input_tokens, cached_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_output_tokens, total_tokens };
}

function addTotals(target, delta) {
  for (const key of ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    target[key] = finite(target[key]) + finite(delta?.[key]);
  }
}

function emptyTotals() {
  return tokenTotals({});
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function updateBounds(bounds, value) {
  const timestamp = safeTimestamp(value);
  if (!timestamp) return;
  if (!bounds.started_at || timestamp < bounds.started_at) bounds.started_at = timestamp;
  if (!bounds.ended_at || timestamp > bounds.ended_at) bounds.ended_at = timestamp;
}

function projectKey(cwd, filePath) {
  const value = cwd || path.dirname(filePath || "");
  return path.basename(String(value).replace(/[\\/]+$/, "")) || "unknown";
}

function extractClaudePrompt(obj) {
  if (!obj || obj.type !== "user" || obj.isMeta) return null;
  const content = obj.message?.content;
  if (Array.isArray(content)) {
    if (content.length > 0 && content.every((block) => block?.type === "tool_result")) return null;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return null;
    if (text === "[Request interrupted by user]" || text.startsWith("<task-notification>")) return null;
    return text;
  }
  if (typeof content !== "string") return null;
  const text = content.trim();
  if (!text || text === "[Request interrupted by user]" || text.startsWith("<task-notification>")) return null;
  return text;
}

function promptFingerprint(prompt) {
  return crypto.createHash("sha256").update(prompt.replace(/\s+/g, " ")).digest("hex");
}

function extractCodexPrompt(obj) {
  if (obj?.type !== "event_msg" || obj.payload?.type !== "user_message") return null;
  if (typeof obj.payload.message === "string") {
    const message = obj.payload.message.trim();
    return message || null;
  }
  const elements = Array.isArray(obj.payload.text_elements) ? obj.payload.text_elements : [];
  const text = elements
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.value === "string") return item.value;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function canonicalToolName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) return "";
  return name.replace(/^functions[.:/]/, "").replace(/^tools[.:/]/, "");
}

function extractCodexSignalTools(payload) {
  if (!payload || !["function_call", "custom_tool_call"].includes(payload.type)) return [];
  const directName = canonicalToolName(payload.name);
  if (directName && directName !== "exec") return [directName];
  if (directName !== "exec" || typeof payload.input !== "string") return [];

  const names = [];
  for (const name of CODEX_SIGNAL_TOOLS) {
    const pattern = new RegExp(`\\btools\\.${name}\\s*\\(`, "gi");
    for (const _match of payload.input.matchAll(pattern)) names.push(name);
  }
  return names;
}

function finalizeRecord(record) {
  const startedMs = Date.parse(record.started_at || "");
  const endedMs = Date.parse(record.ended_at || "");
  record.duration_ms = Number.isFinite(startedMs) && Number.isFinite(endedMs)
    ? Math.max(0, endedMs - startedMs)
    : 0;
  record.total_tokens = finite(record.total_tokens || record.tokens?.total_tokens);
  record.cost_usd = computeRowCost({ source: record.source, model: record.model, ...record.tokens });
  record.productive = record.edit_turns > 0;
  // A first-pass delivery has exactly one user turn containing an observed
  // edit and no repeated user request. The legacy one_shot field stays as an
  // API/CSV alias, but now follows this cross-provider definition.
  record.first_pass = record.edit_turns === 1 && record.retry_turns === 0;
  record.one_shot = record.first_pass;
  record.tokens_per_edit = record.edit_turns > 0 ? record.total_tokens / record.edit_turns : null;
  record.cost_per_edit = record.edit_turns > 0 ? record.cost_usd / record.edit_turns : null;
  return record;
}

async function scanClaudeSession(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const tokens = emptyTotals();
  const seenMessages = new Set();
  const bounds = { started_at: null, ended_at: null };
  let rawSessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let model = "unknown";
  let turns = 0;
  let editTurns = 0;
  let retryTurns = 0;
  let currentHadEdit = false;
  let subagentCalls = 0;
  const subagentTypes = new Map();

  function closeTurn() {
    if (currentHadEdit) {
      editTurns += 1;
    }
    currentHadEdit = false;
  }
  let lastPromptFingerprint = null;

  for await (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    updateBounds(bounds, obj.timestamp || obj.message?.timestamp);
    if (typeof obj.sessionId === "string" && obj.sessionId) rawSessionId = obj.sessionId;
    if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
    if (obj.type === "user") {
      const prompt = extractClaudePrompt(obj);
      if (!prompt) continue;
      const fingerprint = promptFingerprint(prompt);
      if (lastPromptFingerprint && fingerprint === lastPromptFingerprint) retryTurns += 1;
      lastPromptFingerprint = fingerprint;
      closeTurn();
      turns += 1;
      continue;
    }
    if (obj.type !== "assistant" || !obj.message) continue;
    const dedupKey = claudeMessageDedupKey(obj);
    if (dedupKey && seenMessages.has(dedupKey)) continue;
    if (dedupKey) seenMessages.add(dedupKey);
    // Claude writes internal summary/observer messages with model
    // "<synthetic>". They are not a billable model and can appear after the
    // real assistant messages in the same session. Keep the latest real
    // model instead of letting that marker overwrite it.
    const candidateModel = normalizeSessionModel(obj.message.model);
    if (candidateModel) model = candidateModel;
    addTotals(tokens, tokenTotals(obj.message.usage));
    const content = Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      const name = String(block.name || "").toLowerCase();
      if (EDIT_TOOLS.has(name)) currentHadEdit = true;
      if (name === "agent" || name === "task") {
        subagentCalls += 1;
        const subtype = typeof block.input?.subagent_type === "string"
          ? block.input.subagent_type.trim().slice(0, 64)
          : "unspecified";
        subagentTypes.set(subtype || "unspecified", (subagentTypes.get(subtype || "unspecified") || 0) + 1);
      }
    }
  }
  closeTurn();
  return finalizeRecord({
    version: SIDECAR_VERSION,
    session_hash: sessionHash("claude", rawSessionId),
    source: "claude",
    project_key: projectKey(cwd, filePath),
    project_ref: cwd || null,
    model,
    ...bounds,
    turns,
    edit_turns: editTurns,
    retry_turns: retryTurns,
    subagent_calls: subagentCalls,
    subagent_types: Object.fromEntries([...subagentTypes.entries()].sort()),
    tokens,
    provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "inferred", content_retained: false },
  });
}

async function scanCodexDeliverySignals(filePath) {
  const bounds = { started_at: null, ended_at: null };
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let turns = 0;
  let editTurns = 0;
  let retryTurns = 0;
  let currentTurnOpen = false;
  let currentTurnKey = null;
  let currentHadEdit = false;
  let hasTurnContext = false;
  let lastPromptFingerprint = null;
  let subagentCalls = 0;
  const subagentTypes = new Map();

  function closeTurn() {
    if (currentTurnOpen && currentHadEdit) editTurns += 1;
    currentHadEdit = false;
  }

  function beginTurn(key) {
    if (currentTurnOpen && key && currentTurnKey === key) return;
    if (currentTurnOpen) closeTurn();
    currentTurnOpen = true;
    currentTurnKey = key || null;
    turns += 1;
  }

  for await (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    updateBounds(bounds, obj.timestamp);
    if (obj.type === "turn_context") {
      hasTurnContext = true;
      beginTurn(String(obj.payload?.turn_id || obj.timestamp || turns + 1));
      continue;
    }
    const prompt = extractCodexPrompt(obj);
    if (prompt) {
      const fingerprint = promptFingerprint(prompt);
      if (lastPromptFingerprint && fingerprint === lastPromptFingerprint) retryTurns += 1;
      lastPromptFingerprint = fingerprint;
      if (!hasTurnContext) beginTurn(String(obj.timestamp || turns + 1));
      continue;
    }
    if (obj.type !== "response_item") continue;
    const toolNames = extractCodexSignalTools(obj.payload);
    if (!toolNames.length) continue;
    if (!currentTurnOpen) beginTurn(String(obj.timestamp || turns + 1));
    if (toolNames.some((name) => EDIT_TOOLS.has(name))) currentHadEdit = true;
    for (const name of toolNames) {
      if (!CODEX_SUBAGENT_TOOLS.has(name)) continue;
      subagentCalls += 1;
      const displayName = name === "multi_agent_v1__spawn_agent" ? "spawn_agent" : name;
      subagentTypes.set(displayName, (subagentTypes.get(displayName) || 0) + 1);
    }
  }
  closeTurn();
  return {
    bounds,
    turns,
    editTurns,
    retryTurns,
    subagentCalls,
    subagentTypes: Object.fromEntries([...subagentTypes.entries()].sort()),
  };
}

async function scanCodexSession(filePath) {
  const [parsed, signals] = await Promise.all([
    parseCodexRolloutFile(filePath),
    scanCodexDeliverySignals(filePath),
  ]);
  const parsedModel = normalizeSessionModel(parsed.model);
  const provider = normalizeSessionModel(parsed.provider);
  // Older Codex rollouts can omit turn_context.model. The shared parser then
  // falls back to model_provider (for example "openai"), which is provenance
  // rather than a model and must not become a model-table row.
  const model = parsedModel && parsedModel.toLowerCase() !== provider?.toLowerCase()
    ? parsedModel
    : "unknown";
  return finalizeRecord({
    version: SIDECAR_VERSION,
    session_hash: sessionHash("codex", parsed.sessionId || filePath),
    source: "codex",
    project_key: projectKey(parsed.cwd, filePath),
    project_ref: parsed.cwd || null,
    model,
    ...signals.bounds,
    turns: signals.turns || finite(parsed.turnCount),
    edit_turns: signals.editTurns,
    retry_turns: signals.retryTurns,
    subagent_calls: signals.subagentCalls,
    subagent_types: signals.subagentTypes,
    tokens: parsed.totals || emptyTotals(),
    provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "inferred", content_retained: false },
  });
}

async function discoverSessionFiles(home) {
  const [allClaude, codex, archived] = await Promise.all([
    listClaudeProjectFiles(path.join(home, ".claude", "projects")),
    listRolloutFilesDeep(path.join(home, ".codex", "sessions")),
    listRolloutFilesDeep(path.join(home, ".codex", "archived_sessions")),
  ]);
  // Claude Memory stores thousands of background observer transcripts beside
  // real Claude Code sessions. They contain <synthetic>/haiku bookkeeping and
  // no user coding outcome, so scanning them both slows the card dramatically
  // and dilutes its efficiency metrics.
  const claude = allClaude.filter((filePath) => !filePath
    .split(path.sep)
    .some((segment) => segment.endsWith(CLAUDE_MEM_OBSERVER_PROJECT_SUFFIX)));
  const codexBySession = new Map();
  const mtimeOf = (filePath) => {
    try { return fs.statSync(filePath).mtimeMs; } catch { return -Infinity; }
  };
  for (const filePath of [...codex, ...archived]) {
    const id = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] || filePath;
    const previous = codexBySession.get(id);
    if (!previous || mtimeOf(filePath) > mtimeOf(previous)) codexBySession.set(id, filePath);
  }
  return { claude, codex: [...codexBySession.values()] };
}

function filesSignature(files) {
  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      hash.update(`${filePath}\0${stat.size}\0${stat.mtimeMs}\n`);
    } catch { /* vanished during discovery */ }
  }
  return hash.digest("hex");
}

function sessionFileCacheKey(source, filePath) {
  return crypto
    .createHash("sha256")
    .update(`${source}\0${path.resolve(filePath)}`)
    .digest("hex")
    .slice(0, 24);
}

function sessionFileStatKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function readSidecar(sidecarPath) {
  try {
    return fs.readFileSync(sidecarPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, filePath);
}

async function buildSessionAnalyticsInternal({ home = os.homedir(), force = false, cacheTtlMs = 5 * 60_000 } = {}) {
  const sidecarPath = resolveSessionSidecarPath(home);
  const metaPath = `${sidecarPath}.meta.json`;
  let previousMeta = null;
  if (!force) {
    try {
      previousMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const checkedAt = Date.parse(previousMeta.checked_at || previousMeta.generated_at || "");
      if (
        previousMeta.version === SIDECAR_VERSION &&
        Number.isFinite(checkedAt) &&
        Date.now() - checkedAt < Math.max(0, Number(cacheTtlMs) || 0)
      ) {
        return readSidecar(sidecarPath);
      }
    } catch { /* first run */ }
  }
  const discovered = await discoverSessionFiles(home);
  const signature = filesSignature([...discovered.claude, ...discovered.codex]);
  if (!force && previousMeta?.version === SIDECAR_VERSION && previousMeta.signature === signature) {
    await writeAtomic(metaPath, `${JSON.stringify({ ...previousMeta, checked_at: new Date().toISOString() })}\n`);
    return readSidecar(sidecarPath);
  }

  const previousRows = !force && previousMeta?.version === SIDECAR_VERSION
    ? readSidecar(sidecarPath)
    : [];
  const previousRowsByFile = new Map(previousRows
    .filter((row) => typeof row?._cache_key === "string")
    .map((row) => [row._cache_key, row]));
  const previousFiles = previousMeta?.version === SIDECAR_VERSION && previousMeta.files
    ? previousMeta.files
    : {};
  const nextFiles = {};
  const sessions = [];
  const entries = [
    ...discovered.claude.map((filePath) => ({ source: "claude", filePath, scan: scanClaudeSession })),
    ...discovered.codex.map((filePath) => ({ source: "codex", filePath, scan: scanCodexSession })),
  ];
  for (const entry of entries) {
    const cacheKey = sessionFileCacheKey(entry.source, entry.filePath);
    const statKey = sessionFileStatKey(entry.filePath);
    if (!statKey) continue;
    let row = null;
    if (!force && previousFiles[cacheKey]?.stat_key === statKey) {
      row = previousRowsByFile.get(cacheKey) || null;
    }
    if (!row) {
      try { row = await entry.scan(entry.filePath); } catch { /* one active/partial session must not poison the sidecar */ }
    }
    if (!row) continue;
    // A one-way file hash enables incremental reuse without persisting or
    // exposing the user's local session path.
    row._cache_key = cacheKey;
    sessions.push(row);
    nextFiles[cacheKey] = { stat_key: statKey };
  }
  sessions.sort((a, b) => String(b.ended_at || "").localeCompare(String(a.ended_at || "")));
  const content = sessions.map((row) => JSON.stringify(row)).join("\n") + (sessions.length ? "\n" : "");
  await writeAtomic(sidecarPath, content);
  const generatedAt = new Date().toISOString();
  await writeAtomic(metaPath, `${JSON.stringify({
    version: SIDECAR_VERSION,
    signature,
    generated_at: generatedAt,
    checked_at: generatedAt,
    files: nextFiles,
  })}\n`);
  return sessions;
}

// A cold scan walks every local Claude/Codex session file. Period switches can
// issue overlapping requests while that scan is still running; share the
// promise per home so those requests wait for one scan instead of multiplying
// the disk work and racing the atomic sidecar write.
const sessionAnalyticsBuilds = new Map();

function buildSessionAnalytics(options = {}) {
  const normalizedOptions = options && typeof options === "object" ? options : {};
  const home = path.resolve(String(normalizedOptions.home || os.homedir()));
  const existing = sessionAnalyticsBuilds.get(home);
  if (existing) return existing;

  const promise = buildSessionAnalyticsInternal({ ...normalizedOptions, home });
  sessionAnalyticsBuilds.set(home, promise);
  const clear = () => {
    if (sessionAnalyticsBuilds.get(home) === promise) sessionAnalyticsBuilds.delete(home);
  };
  promise.then(clear, clear);
  return promise;
}

function summarizeSessions(sessions, { from = "", to = "", includeSessions = true } = {}) {
  const filtered = (sessions || []).filter((row) => {
    const day = String(row.started_at || row.ended_at || "").slice(0, 10);
    return (!from || day >= from) && (!to || day <= to);
  });
  const byModel = new Map();
  const subagents = new Map();
  for (const row of filtered) {
    const key = row.model || "unknown";
    const agg = byModel.get(key) || {
      model: key,
      sessions: 0,
      productive_sessions: 0,
      one_shot_sessions: 0,
      edit_turns: 0,
      retries: 0,
      total_tokens: 0,
      cost_usd: 0,
      edit_tokens: 0,
      edit_cost_usd: 0,
    };
    agg.sessions += 1;
    if (row.productive) agg.productive_sessions += 1;
    if (row.first_pass ?? row.one_shot) agg.one_shot_sessions += 1;
    agg.edit_turns += finite(row.edit_turns);
    agg.retries += finite(row.retry_turns);
    agg.total_tokens += finite(row.total_tokens);
    agg.cost_usd += finite(row.cost_usd);
    if (row.productive) {
      agg.edit_tokens += finite(row.total_tokens);
      agg.edit_cost_usd += finite(row.cost_usd);
    }
    byModel.set(key, agg);
    for (const [name, calls] of Object.entries(row.subagent_types || {})) {
      const sub = subagents.get(name) || { name, calls: 0, sessions: 0, total_tokens: 0, cost_usd: 0 };
      sub.calls += finite(calls);
      sub.sessions += 1;
      // Token allocation is an explicit estimate because vendor logs do not
      // consistently expose child usage separately.
      const share = Math.min(1, finite(calls) / Math.max(1, finite(row.turns)));
      sub.total_tokens += finite(row.total_tokens) * share;
      sub.cost_usd += finite(row.cost_usd) * share;
      subagents.set(name, sub);
    }
  }
  const by_model = [...byModel.values()].map((row) => ({
    ...row,
    productive_rate: row.sessions ? row.productive_sessions / row.sessions : null,
    one_shot_rate: row.productive_sessions ? row.one_shot_sessions / row.productive_sessions : null,
    edit_sessions: row.productive_sessions,
    first_pass_sessions: row.one_shot_sessions,
    edit_session_rate: row.sessions ? row.productive_sessions / row.sessions : null,
    first_pass_rate: row.productive_sessions ? row.one_shot_sessions / row.productive_sessions : null,
    tokens_per_edit: row.edit_turns ? row.edit_tokens / row.edit_turns : null,
    cost_per_edit: row.edit_turns ? row.edit_cost_usd / row.edit_turns : null,
  })).sort((a, b) => b.edit_turns - a.edit_turns || b.productive_sessions - a.productive_sessions || b.sessions - a.sessions);
  const totals = by_model.reduce((acc, row) => {
    for (const key of ["sessions", "productive_sessions", "one_shot_sessions", "edit_turns", "retries", "total_tokens", "cost_usd", "edit_tokens", "edit_cost_usd"]) acc[key] += finite(row[key]);
    return acc;
  }, { sessions: 0, productive_sessions: 0, one_shot_sessions: 0, edit_turns: 0, retries: 0, total_tokens: 0, cost_usd: 0, edit_tokens: 0, edit_cost_usd: 0 });
  return {
    available: filtered.length > 0,
    // Local filesystem paths are required internally for Git attribution but
    // never leave the Node process through API/CSV payloads.
    sessions: includeSessions
      ? filtered.map(({ project_ref: _projectRef, _cache_key: _cacheKey, ...row }) => row)
      : [],
    session_count: filtered.length,
    summary: {
      ...totals,
      productive_rate: totals.sessions ? totals.productive_sessions / totals.sessions : null,
      one_shot_rate: totals.productive_sessions ? totals.one_shot_sessions / totals.productive_sessions : null,
      edit_sessions: totals.productive_sessions,
      first_pass_sessions: totals.one_shot_sessions,
      edit_session_rate: totals.sessions ? totals.productive_sessions / totals.sessions : null,
      first_pass_rate: totals.productive_sessions ? totals.one_shot_sessions / totals.productive_sessions : null,
      tokens_per_edit: totals.edit_turns ? totals.edit_tokens / totals.edit_turns : null,
      cost_per_edit: totals.edit_turns ? totals.edit_cost_usd / totals.edit_turns : null,
    },
    by_model,
    subagents: [...subagents.values()].sort((a, b) => b.calls - a.calls),
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      privacy: "metadata-only",
      methodology: "edit-turn-v2",
      edit_turn: "user turn containing an observed edit tool",
      first_pass: "exactly one edit turn and no repeated user request",
    },
  };
}

function sessionsToCsv(rows) {
  const columns = ["session_hash", "source", "project_key", "model", "started_at", "ended_at", "duration_ms", "turns", "edit_turns", "retry_turns", "subagent_calls", "total_tokens", "cost_usd", "productive", "first_pass", "one_shot"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.join(","), ...(rows || []).map((row) => columns.map((key) => escape(row[key])).join(","))].join("\n") + "\n";
}

module.exports = {
  resolveSessionSidecarPath,
  sessionHash,
  scanClaudeSession,
  scanCodexSession,
  buildSessionAnalytics,
  summarizeSessions,
  sessionsToCsv,
};
