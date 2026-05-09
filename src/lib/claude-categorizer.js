// Claude Code "Context Breakdown" categorizer.
//
// Reads ~/.claude/projects/**/*.jsonl and splits each assistant message's
// usage into seven semantic buckets, mirroring (approximately) the Claude
// Code in-CLI /context view but as a historical aggregate. Computes on
// demand — no queue schema changes, no parser changes, no sync changes.
//
// Why these seven and not the screenshot's eight: the raw system prompt
// (which contains tools schema, skills, rules, MCP descriptions) is sent
// once per session as a 1h-ephemeral cache prefix and is never logged
// verbatim in the jsonl. So at the token-accounting layer those four are
// indistinguishable — they all collapse into `system_prefix`. UI says so.
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const CATEGORY_KEYS = [
  "system_prefix",
  "conversation_history",
  "user_input",
  "tool_calls",
  "subagents",
  "reasoning",
  "assistant_response",
];

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

function emptyTotals() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function emptyCategoryMap() {
  const out = {};
  for (const key of CATEGORY_KEYS) out[key] = emptyTotals();
  return out;
}

function addInto(target, source) {
  target.input_tokens += source.input_tokens || 0;
  target.cached_input_tokens += source.cached_input_tokens || 0;
  target.cache_creation_input_tokens += source.cache_creation_input_tokens || 0;
  target.output_tokens += source.output_tokens || 0;
  target.reasoning_output_tokens += source.reasoning_output_tokens || 0;
  target.total_tokens += source.total_tokens || 0;
}

function defaultClaudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function listSessionFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(fp);
      }
    }
  }
  return out;
}

// Distribute one assistant message's output tokens across categories by the
// character-length ratio of each content block. Thinking goes to reasoning,
// tool_use(Agent|Task) → subagents, tool_use(other) → tool_calls, text →
// assistant_response. If reasoning_output_tokens is reported separately, use
// that exact figure for reasoning instead of pro-rating.
function splitOutputByContent(usage, content, breakdown) {
  const total = Math.max(0, Number(usage.output_tokens || 0));
  const reasoningExplicit = Math.max(0, Number(usage.reasoning_output_tokens || 0));
  if (total === 0) return;

  const blocks = Array.isArray(content) ? content : [];
  const buckets = { reasoning: 0, tool_calls: 0, subagents: 0, assistant_response: 0 };
  let totalChars = 0;

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    let chars = 0;
    if (type === "thinking") {
      chars = String(block.thinking || block.text || "").length || 1;
      buckets.reasoning += chars;
    } else if (type === "text") {
      chars = String(block.text || "").length || 1;
      buckets.assistant_response += chars;
    } else if (type === "tool_use") {
      const inputJson = block.input ? JSON.stringify(block.input) : "";
      chars = (block.name || "").length + inputJson.length + 1;
      if (SUBAGENT_TOOL_NAMES.has(block.name)) buckets.subagents += chars;
      else buckets.tool_calls += chars;
    } else {
      continue;
    }
    totalChars += chars;
  }

  if (totalChars === 0) {
    breakdown.assistant_response.output_tokens += total;
    breakdown.assistant_response.total_tokens += total;
    return;
  }

  // If the API reported reasoning tokens explicitly, peel them off first
  // and pro-rate the rest of the output across the remaining buckets.
  let nonReasoningOutput = total;
  if (reasoningExplicit > 0) {
    const reasoningShare = Math.min(reasoningExplicit, total);
    breakdown.reasoning.output_tokens += reasoningShare;
    breakdown.reasoning.reasoning_output_tokens += reasoningShare;
    breakdown.reasoning.total_tokens += reasoningShare;
    nonReasoningOutput = total - reasoningShare;
    // Drop the thinking-char contribution; it was just paid for.
    totalChars -= buckets.reasoning;
    buckets.reasoning = 0;
  }

  if (nonReasoningOutput <= 0 || totalChars <= 0) return;

  // Largest-remainder rounding so the four sub-buckets sum exactly to
  // nonReasoningOutput (no off-by-one drift across thousands of messages).
  const order = ["reasoning", "tool_calls", "subagents", "assistant_response"];
  const exact = order.map((k) => (buckets[k] / totalChars) * nonReasoningOutput);
  const floored = exact.map((x) => Math.floor(x));
  const remainder = nonReasoningOutput - floored.reduce((a, b) => a + b, 0);
  const remainders = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[remainders[k % order.length].i] += 1;

  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    const tok = floored[i];
    if (tok === 0) continue;
    breakdown[key].output_tokens += tok;
    breakdown[key].total_tokens += tok;
    if (key === "reasoning") breakdown[key].reasoning_output_tokens += tok;
  }
}

// Per-session state lets us pick out the *first* meaningful cache_creation
// chunk and call that the system_prefix. Subsequent cache_creations are
// incremental — we attribute them to conversation_history.
function classifyOneMessage(obj, sessionState, breakdown) {
  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return;

  const cacheCreate = Math.max(0, Number(usage.cache_creation_input_tokens || 0));
  const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens || 0));
  const inputNonCached = Math.max(0, Number(usage.input_tokens || 0));
  const output = Math.max(0, Number(usage.output_tokens || 0));

  // input_tokens (pure non-cached) → user_input
  if (inputNonCached > 0) {
    breakdown.user_input.input_tokens += inputNonCached;
    breakdown.user_input.total_tokens += inputNonCached;
  }

  // cache_read_input_tokens → conversation_history (replaying earlier turns)
  if (cacheRead > 0) {
    breakdown.conversation_history.cached_input_tokens += cacheRead;
    breakdown.conversation_history.total_tokens += cacheRead;
  }

  // cache_creation_input_tokens: first big block of a session = system_prefix,
  // everything after = incremental conversation history.
  if (cacheCreate > 0) {
    if (!sessionState.systemPrefixSeen) {
      breakdown.system_prefix.cache_creation_input_tokens += cacheCreate;
      breakdown.system_prefix.total_tokens += cacheCreate;
      sessionState.systemPrefixSeen = true;
    } else {
      breakdown.conversation_history.cache_creation_input_tokens += cacheCreate;
      breakdown.conversation_history.total_tokens += cacheCreate;
    }
  }

  // Split output across reasoning / tool_calls / subagents / assistant_response.
  if (output > 0) {
    splitOutputByContent(
      { output_tokens: output, reasoning_output_tokens: usage.reasoning_output_tokens },
      obj?.message?.content,
      breakdown,
    );
  }
}

// Read one session jsonl streaming, in timestamp range, dedup by msgId+reqId.
async function categorizeSessionFile(filePath, { fromIso, toIso, seenHashes }, breakdown) {
  let stream;
  try {
    stream = fssync.createReadStream(filePath, { encoding: "utf8" });
  } catch (_e) {
    return 0;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const sessionState = { systemPrefixSeen: false };
  let counted = 0;

  for await (const line of rl) {
    if (!line || !line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!ts) continue;
    if (fromIso && ts < fromIso) continue;
    if (toIso && ts > toIso) continue;

    const msgId = obj?.message?.id;
    const reqId = obj?.requestId;
    if (msgId && reqId) {
      const hash = `${msgId}:${reqId}`;
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
    }

    classifyOneMessage(obj, sessionState, breakdown);
    counted += 1;
  }
  rl.close();
  stream.close?.();
  return counted;
}

// Convert a YYYY-MM-DD day key (already in the user's tz from the API call)
// into an inclusive ISO range. We still match against UTC timestamps in the
// jsonl, so we widen by ±14h to be safe across timezones — totals are
// post-filtered against the queue's authoritative UTC totals anyway, this
// view is approximate by design.
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

// Cache: keyed on (rootDir|from|to|maxMtime). 60s TTL is a safety net in
// case the watcher misses something.
const CACHE = new Map();
const CACHE_TTL_MS = 60_000;

function maxMtimeMs(files) {
  let max = 0;
  for (const fp of files) {
    try {
      const st = fssync.statSync(fp);
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch (_e) {}
  }
  return max;
}

async function computeClaudeCategoryBreakdown({ from = null, to = null, rootDir = null, projectDir = null } = {}) {
  const root = rootDir || defaultClaudeProjectsDir();
  let files = [];
  try {
    files = listSessionFiles(root);
  } catch (_e) {
    return {
      source: "claude",
      scope: "supported",
      totals: emptyTotals(),
      categories: CATEGORY_KEYS.map((key) => ({
        key,
        totals: emptyTotals(),
        percent: 0,
      })),
      session_count: 0,
      message_count: 0,
    };
  }

  const cacheKey = `${root}|${from || ""}|${to || ""}|${files.length}|${maxMtimeMs(files)}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const { fromIso, toIso } = dayKeyToIsoBounds(from, to);
  const breakdown = emptyCategoryMap();
  const seenHashes = new Set();
  let messageCount = 0;
  let sessionCount = 0;

  for (const fp of files) {
    const counted = await categorizeSessionFile(
      fp,
      { fromIso, toIso, seenHashes },
      breakdown,
    );
    if (counted > 0) sessionCount += 1;
    messageCount += counted;
  }

  const totals = emptyTotals();
  for (const key of CATEGORY_KEYS) addInto(totals, breakdown[key]);

  const result = {
    source: "claude",
    scope: "supported",
    totals,
    categories: CATEGORY_KEYS.map((key) => {
      const t = breakdown[key];
      const percent = totals.total_tokens > 0
        ? Number(((t.total_tokens / totals.total_tokens) * 100).toFixed(2))
        : 0;
      return { key, totals: t, percent };
    }),
    session_count: sessionCount,
    message_count: messageCount,
  };

  CACHE.set(cacheKey, { at: Date.now(), value: result });
  // Bound cache size — categorizer is cheap to recompute, no point hoarding.
  if (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return result;
}

// Lightweight on-disk count of static resources Claude Code's /context UI
// also surfaces (Skills, MCP servers, Memory files, Custom agents). These are
// counts of what's *installed*, not historical token usage — the same way
// /context shows "MCP tools 0 (115)" with the install count in parens. Lets
// the dashboard match that vocabulary even though token-level separation
// from the system prompt isn't possible from the rollout logs alone.
function countDirEntries(dir, predicate) {
  let entries;
  try {
    entries = fssync.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return 0;
  }
  return entries.filter(predicate).length;
}

function fileExists(fp) {
  try {
    return fssync.statSync(fp).isFile();
  } catch (_e) {
    return false;
  }
}

function safeReadJson(fp) {
  try {
    return JSON.parse(fssync.readFileSync(fp, "utf8"));
  } catch (_e) {
    return null;
  }
}

// Walk @./path imports recursively. Claude Code expands @file references
// inside CLAUDE.md into separate memory entries; /context counts them.
function collectMemoryImports(filePath, seen) {
  if (!filePath || seen.has(filePath)) return;
  seen.add(filePath);
  let raw;
  try {
    raw = fssync.readFileSync(filePath, "utf8");
  } catch (_e) {
    return;
  }
  const dir = path.dirname(filePath);
  // Match `@path/to/file.md` (CC's import syntax), but skip `@user@host` and
  // `email@host` patterns by requiring a path-like suffix.
  const re = /(?:^|\s)@([./~][^\s)]+\.md)\b/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let target = m[1];
    if (target.startsWith("~")) target = path.join(os.homedir(), target.slice(1).replace(/^\//, ""));
    else if (!path.isAbsolute(target)) target = path.resolve(dir, target);
    if (fileExists(target)) collectMemoryImports(target, seen);
  }
}

function findLatestPluginVersionDir(pluginCacheRoot) {
  let entries;
  try {
    entries = fssync.readdirSync(pluginCacheRoot, { withFileTypes: true });
  } catch (_e) {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return null;
  // Pick highest semver-ish lex sort fallback. CC keeps the active version
  // path under the plugin's cache; if multiple versions linger, the lexically
  // largest is usually the latest installed.
  dirs.sort();
  return path.join(pluginCacheRoot, dirs[dirs.length - 1]);
}

function countSkillsInDir(rootDir) {
  // Walk subdirs once looking for SKILL.md / skill.md.
  let count = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (fileExists(path.join(sub, "SKILL.md")) || fileExists(path.join(sub, "skill.md"))) {
        count += 1;
      } else {
        stack.push(sub);
      }
    }
  }
  return count;
}

function countAgentMarkdowns(rootDir) {
  let count = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(fp);
      else if (e.isFile() && e.name.endsWith(".md")) count += 1;
    }
  }
  return count;
}

function listEnabledPlugins() {
  const home = os.homedir();
  // settings.local.json overrides settings.json (CC's normal precedence).
  const baseMap = safeReadJson(path.join(home, ".claude", "settings.json"))?.enabledPlugins || {};
  const localMap = safeReadJson(path.join(home, ".claude", "settings.local.json"))?.enabledPlugins || {};
  const merged = { ...baseMap, ...localMap };
  return Object.entries(merged)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

function getConfiguredResources({ projectDir = null } = {}) {
  const home = os.homedir();
  const claudeRoot = path.join(home, ".claude");
  const cacheRoot = path.join(claudeRoot, "plugins", "cache");

  // --- Skills ------------------------------------------------------------
  let skillsCount = countSkillsInDir(path.join(claudeRoot, "skills"));
  if (projectDir) {
    skillsCount += countSkillsInDir(path.join(projectDir, ".claude", "skills"));
  }

  // --- Custom agents -----------------------------------------------------
  let agentsCount = countAgentMarkdowns(path.join(claudeRoot, "agents"));
  if (projectDir) {
    agentsCount += countAgentMarkdowns(path.join(projectDir, ".claude", "agents"));
  }

  // --- MCP servers -------------------------------------------------------
  // Primary: ~/.claude.json (single dot-json — CC's main config), NOT
  // ~/.claude/settings.json (which holds GUI toggles, not MCP).
  let mcpCount = 0;
  const claudeJson = safeReadJson(path.join(home, ".claude.json"));
  if (claudeJson?.mcpServers && typeof claudeJson.mcpServers === "object") {
    mcpCount += Object.keys(claudeJson.mcpServers).length;
  }
  if (projectDir) {
    const projectMcp = safeReadJson(path.join(projectDir, ".mcp.json"));
    if (projectMcp?.mcpServers && typeof projectMcp.mcpServers === "object") {
      mcpCount += Object.keys(projectMcp.mcpServers).length;
    }
  }

  // --- Plugin contributions (enabled plugins only) -----------------------
  // Plugin caches live at ~/.claude/plugins/cache/<owner>/<plugin>/<version>/
  // and contribute skills, agents, and mcpServers (declared in plugin.json).
  for (const pluginKey of listEnabledPlugins()) {
    // pluginKey is "name@marketplace" (e.g., "claude-mem@thedotmack").
    const [name, marketplace] = pluginKey.split("@");
    if (!name || !marketplace) continue;
    const pluginRoot = path.join(cacheRoot, marketplace, name);
    const versionDir = findLatestPluginVersionDir(pluginRoot);
    if (!versionDir) continue;
    skillsCount += countSkillsInDir(path.join(versionDir, "skills"));
    agentsCount += countAgentMarkdowns(path.join(versionDir, "agents"));
    const pluginManifest = safeReadJson(path.join(versionDir, ".claude-plugin", "plugin.json"));
    if (pluginManifest?.mcpServers && typeof pluginManifest.mcpServers === "object") {
      mcpCount += Object.keys(pluginManifest.mcpServers).length;
    }
  }

  // --- Memory files (CLAUDE.md + transitive @-imports) -------------------
  const memorySeen = new Set();
  const userMd = path.join(claudeRoot, "CLAUDE.md");
  const homeMd = path.join(home, "CLAUDE.md");
  if (fileExists(userMd)) collectMemoryImports(userMd, memorySeen);
  if (fileExists(homeMd) && fssync.statSync(homeMd).size > 0) collectMemoryImports(homeMd, memorySeen);
  // Walk up from projectDir to find the closest CLAUDE.md (CC walks up too).
  // Handles dev servers running from a subdir (e.g. vite from dashboard/).
  if (projectDir) {
    let cursor = projectDir;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(cursor, "CLAUDE.md");
      if (fileExists(candidate)) {
        collectMemoryImports(candidate, memorySeen);
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  return {
    skills_count: skillsCount,
    custom_agents_count: agentsCount,
    memory_files_count: memorySeen.size,
    mcp_servers_count: mcpCount,
  };
}

function unsupportedSourcePayload(source) {
  return {
    source,
    scope: "unsupported",
    totals: emptyTotals(),
    categories: CATEGORY_KEYS.map((key) => ({
      key,
      totals: emptyTotals(),
      percent: 0,
    })),
    session_count: 0,
    message_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Ground-truth bucket aggregator for queue.jsonl repair.
//
// `sync.js` historically used a stateful incremental pipeline (cursor offsets
// + persisted hash set) and the `reincludeClaudeMemObserverFiles` migration
// shipped 3 versions, each of which reset the hash set and re-read observer
// jsonls. Result: queue.jsonl ended up with ~+40% extra Claude tokens that
// never actually existed.
//
// This function is the source-of-truth replacement: scan every Claude jsonl,
// dedup messages by (msgId, requestId) globally — same algorithm ccusage
// uses — and emit one record per (model, hour_start) bucket. Callers (sync's
// repair migration) write these as authoritative rows to queue.jsonl,
// overwriting whatever was there for source=claude.
// ---------------------------------------------------------------------------

function bucketAccumulator() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    conversation_count: 0,
  };
}

function toUtcHalfHourStart(ts) {
  const dt = new Date(ts);
  if (!Number.isFinite(dt.getTime())) return null;
  const minutes = dt.getUTCMinutes();
  const halfMinute = minutes >= 30 ? 30 : 0;
  return new Date(
    Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      halfMinute,
      0,
      0,
    ),
  ).toISOString();
}

async function computeClaudeGroundTruthBuckets({ rootDir = null } = {}) {
  const root = rootDir || defaultClaudeProjectsDir();
  const files = listSessionFiles(root);
  const buckets = new Map(); // `${model}|${hourStart}` → totals
  const seenHashes = new Set();
  const userMessageBuckets = new Map(); // for conversation_count tracking

  for (const fp of files) {
    let stream;
    try {
      stream = fssync.createReadStream(fp, { encoding: "utf8" });
    } catch (_e) {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const isMainSession = !fp.includes("/subagents/");

    for await (const line of rl) {
      if (!line) continue;

      // Conversation count = main-session user messages with text content
      // (matches what parseClaudeFile in rollout.js does).
      if (isMainSession && line.includes('"type":"user"')) {
        let userObj;
        try {
          userObj = JSON.parse(line);
        } catch (_e) {
          /* skip */
        }
        if (userObj?.type === "user") {
          const content = userObj?.message?.content;
          const hasText =
            typeof content === "string" ||
            (Array.isArray(content) && content.some((b) => b?.type === "text"));
          if (hasText) {
            const ts = typeof userObj?.timestamp === "string" ? userObj.timestamp : null;
            const hourStart = ts ? toUtcHalfHourStart(ts) : null;
            if (hourStart) {
              const k = `unknown|${hourStart}`;
              userMessageBuckets.set(k, (userMessageBuckets.get(k) || 0) + 1);
            }
          }
        }
      }

      if (!line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      const usage = obj?.message?.usage;
      if (!usage || typeof usage !== "object") continue;

      const msgId = obj?.message?.id;
      const reqId = obj?.requestId;
      if (msgId && reqId) {
        const hash = `${msgId}:${reqId}`;
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
      }

      const model = (obj?.message?.model || obj?.model || "unknown").trim() || "unknown";
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      const hourStart = ts ? toUtcHalfHourStart(ts) : null;
      if (!hourStart) continue;

      const inputTok = Math.max(0, Number(usage.input_tokens || 0));
      const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens || 0));
      const cacheCreate = Math.max(0, Number(usage.cache_creation_input_tokens || 0));
      const outputTok = Math.max(0, Number(usage.output_tokens || 0));
      const reasoningTok = Math.max(0, Number(usage.reasoning_output_tokens || 0));
      const total = inputTok + cacheRead + cacheCreate + outputTok;

      const key = `${model}|${hourStart}`;
      let acc = buckets.get(key);
      if (!acc) {
        acc = bucketAccumulator();
        buckets.set(key, acc);
      }
      acc.input_tokens += inputTok;
      acc.cached_input_tokens += cacheRead;
      acc.cache_creation_input_tokens += cacheCreate;
      acc.output_tokens += outputTok;
      acc.reasoning_output_tokens += reasoningTok;
      acc.total_tokens += total;
    }
    rl.close();
    stream.close?.();
  }

  // Stitch user-message conversation counts onto the unknown-model bucket
  // for the same hour (matches rollout.js behavior — user messages are
  // counted under DEFAULT_MODEL because they have no model field).
  for (const [key, count] of userMessageBuckets) {
    let acc = buckets.get(key);
    if (!acc) {
      acc = bucketAccumulator();
      buckets.set(key, acc);
    }
    acc.conversation_count += count;
  }

  const out = [];
  for (const [key, totals] of buckets) {
    const sep = key.indexOf("|");
    const model = key.slice(0, sep);
    const hourStart = key.slice(sep + 1);
    out.push({
      source: "claude",
      model,
      hour_start: hourStart,
      ...totals,
      billable_total_tokens: totals.total_tokens,
    });
  }
  return {
    rows: out,
    seenHashes: Array.from(seenHashes),
    fileList: files,
  };
}

module.exports = {
  CATEGORY_KEYS,
  computeClaudeCategoryBreakdown,
  computeClaudeGroundTruthBuckets,
  unsupportedSourcePayload,
  getConfiguredResources,
  // Exported for tests
  splitOutputByContent,
  classifyOneMessage,
  emptyTotals,
  emptyCategoryMap,
};
