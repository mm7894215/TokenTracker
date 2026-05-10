// Codex CLI "Context Breakdown" — tool-oriented view.
//
// Privacy commitment: tokens + timestamps only. We do not return prompt text,
// assistant text, tool outputs, file contents, or exec_command arguments.
//
// Data source: ~/.codex/sessions/**/rollout-*.jsonl
// We treat each token_count event as the authoritative delta and attribute
// that delta to "turn" activity since the last token_count. Tool attribution
// is heuristic: delta is split evenly across tools used in that turn.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const { listRolloutFiles } = require("./rollout");

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

function addInto(target, delta) {
  target.input_tokens += delta.input_tokens || 0;
  target.cached_input_tokens += delta.cached_input_tokens || 0;
  target.cache_creation_input_tokens += delta.cache_creation_input_tokens || 0;
  target.output_tokens += delta.output_tokens || 0;
  target.reasoning_output_tokens += delta.reasoning_output_tokens || 0;
  target.total_tokens += delta.total_tokens || 0;
}

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

function categorizeTool(name) {
  if (name === "text_response") return "Text Response";
  if (name === "Malformed") return "Malformed";

  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) {
      const serverRaw = parts[1];
      let server;
      const pluginMatch = serverRaw.match(/^plugin_(.+)$/);
      if (pluginMatch) {
        const inner = pluginMatch[1];
        const segments = inner.split("_");
        const half = Math.floor(segments.length / 2);
        const firstHalf = segments.slice(0, half).join("_");
        const secondHalf = segments.slice(half).join("_");
        if (firstHalf && firstHalf === secondHalf) {
          server = firstHalf;
        } else {
          server = inner;
        }
      } else {
        server = serverRaw;
      }
      server = server.replace(/_/g, "-");
      return `MCP: ${server}`;
    }
    return "MCP: Unknown";
  }

  if (/^Task(Create|Update|Get|List|Output|Stop)$/.test(name)) return "Task Mgmt";
  if (/^Todo/.test(name)) return "Task Mgmt";
  if (/Plan/.test(name)) return "Planning";
  if (name === "Agent") return "Agent";
  if (/^Web(Fetch|Search)$/.test(name)) return "Web";
  if (name === "Skill") return "Skill";
  if (name === "LSP") return "IDE";
  if (name === "AskUserQuestion") return "Interaction";

  if (name === "exec_command" || name === "write_stdin") return "Execution";
  if (name === "update_plan") return "Planning";
  if (/_agent$/.test(name)) return "Agent";
  if (/^list_mcp/.test(name)) return "MCP Mgmt";
  if (
    /^(navigate_page|click|select_page|new_page|take_snapshot|take_screenshot|evaluate_script|list_pages|list_console_messages|view_image|emulate|resize_page|wait_for|close_page|get_console_message|get_network_request|list_network_requests|performance_)/.test(
      name
    )
  )
    return "Browser";

  if (name.includes("<tool_call>") || name.includes("<arg_")) return "Malformed";
  return "Other";
}

function inferExecCommandKind(command) {
  const cmd = String(command || "").trim();
  if (/^(npm|yarn|pnpm)\s+(run\s+)?(build|build:|.*:build\b)/.test(cmd)) return "build";
  if (/^(npm|yarn|pnpm)\s+(test|run\s+test\b|run\s+.*test\b)/.test(cmd)) return "test";
  if (/^(npm|yarn|pnpm)\s+run\s+typecheck\b/.test(cmd)) return "typecheck";
  if (/^(npm|yarn|pnpm)\s+(install|add|ci)\b/.test(cmd)) return "dependency";
  if (/^(npm|yarn|pnpm)\s+(pack|publish|version)\b/.test(cmd)) return "package";
  if (/^(npm|yarn|pnpm)\s+run\s+(dev|serve|start|.*dev.*)\b/.test(cmd)) return "dev_server";
  if (/^node\s+--check\b/.test(cmd) || /\bnode\s+--check\b/.test(cmd)) return "syntax_check";
  if (/^node\s+--input-type=module\s+-e\b/.test(cmd) || /^node\s+-e\b/.test(cmd)) return "node_eval";
  if (/^node\s+.*\b(query|analyze|report)\b/.test(cmd)) return "node_cli";
  if (/^git\s+status\b/.test(cmd)) return "git_status";
  if (/^git\s+(push|pull|fetch|clone)\b/.test(cmd) || /\bgit\s+(push|pull|fetch|clone)\b/.test(cmd)) return "git_remote";
  if (/^git\s+(add|commit|branch|config|remote|restore)\b/.test(cmd) || /\bgit\s+(add|commit|branch|config|remote|restore)\b/.test(cmd)) return "git_local";
  if (/^(curl|wget)\b/.test(cmd) || /\b(curl|wget)\b/.test(cmd)) return "http";
  if (/^(ps|pgrep|pkill|kill|lsof)\b/.test(cmd)) return "process";
  if (/^tmux\b/.test(cmd)) return "terminal";
  if (/^(open|osascript)\b/.test(cmd)) return "browser_control";
  if (/^(rm|mkdir|touch|chmod|cp|mv)\b/.test(cmd)) return "file_mutation";
  if (/^(pwd|ls|test)\b/.test(cmd) || /^(pwd|ls)\s*[;&|]/.test(cmd)) return "shell_inspect";
  if (/[;&|]{1,2}/.test(cmd)) return "compound";
  return "unknown";
}

function shellWords(command) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(command || ""))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out.filter(Boolean);
}

function unwrapShellCommand(words) {
  if (words.length >= 3 && /^(bash|sh|zsh|fish)$/.test(words[0]) && words[1] === "-lc") {
    return shellWords(words.slice(2).join(" "));
  }
  if (words.length >= 3 && /^(rtk|env|command|xcrun)$/.test(words[0])) {
    return unwrapShellCommand(words.slice(1));
  }
  return words;
}

function sanitizeCommandSignature(command) {
  const words = unwrapShellCommand(shellWords(command));
  if (words.length === 0) return "unknown";
  const executable = path.basename(words[0] || "unknown");
  const subcommand = words.find((word, idx) => {
    if (idx === 0) return false;
    if (!word || word.startsWith("-")) return false;
    if (/^[A-Z_][A-Z0-9_]*=/.test(word)) return false;
    return true;
  });
  return subcommand ? `${executable} ${subcommand}` : executable;
}

function getExecutableName(command) {
  const words = unwrapShellCommand(shellWords(command));
  if (words.length === 0) return "unknown";
  return path.basename(words[0] || "unknown") || "unknown";
}

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

function buildExecStatsEntry() {
  return {
    calls: 0,
    failures: 0,
    duration_ms: 0,
    max_duration_ms: 0,
    output_chars: 0,
    output_lines: 0,
    totals: emptyTotals(),
  };
}

function buildToolStatsEntry() {
  return {
    calls: 0,
    totals: emptyTotals(),
  };
}

function buildSkillStatsEntry(name) {
  return {
    name,
    calls: 0,
    totals: emptyTotals(),
  };
}

function finalizeToolRows(map) {
  const rows = Array.from(map.values())
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
  return rows;
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
  const rows = Array.from(map.values())
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
  return rows;
}

function roundTotals(totals) {
  return {
    input_tokens: Math.round(totals?.input_tokens || 0),
    cached_input_tokens: Math.round(totals?.cached_input_tokens || 0),
    cache_creation_input_tokens: Math.round(totals?.cache_creation_input_tokens || 0),
    output_tokens: Math.round(totals?.output_tokens || 0),
    reasoning_output_tokens: Math.round(totals?.reasoning_output_tokens || 0),
    total_tokens: Math.round(totals?.total_tokens || 0),
  };
}

function allocateByLargestRemainder(total, weights, order) {
  const out = {};
  if (!Number.isFinite(total) || total <= 0) {
    for (const key of order) out[key] = 0;
    return out;
  }

  let totalWeight = 0;
  for (const key of order) {
    const w = Number(weights[key] || 0);
    if (Number.isFinite(w) && w > 0) totalWeight += w;
  }

  if (totalWeight <= 0) {
    for (const key of order) out[key] = 0;
    return out;
  }

  const exact = order.map((key) => (Number(weights[key] || 0) / totalWeight) * total);
  const floored = exact.map((x) => Math.floor(x));
  const remainder = total - floored.reduce((a, b) => a + b, 0);
  const remainders = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[remainders[k % order.length].i] += 1;

  for (let i = 0; i < order.length; i++) out[order[i]] = floored[i];
  return out;
}

async function parseCodexRolloutFile(filePath, { fromIso, toIso, from = null, to = null, timeZoneContext = null } = {}) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = null;
  let cwd = null;
  let model = null;
  let provider = null;
  let cliVersion = null;
  let firstTimestamp = null;

  let prevTotals = null;
  let pendingCalls = []; // response_item function_call payloads since last token_count
  let pendingSkills = [];
  let pendingExec = new Map(); // call_id -> {cmd, workdir}
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

    // Also attribute exec_command_end rows to exec stats; note these are
    // not a token source — we attach the same tool-shared delta to the
    // command classifier so users can find high-cost command families.
    // If multiple exec_command_end events happened in one turn, split the
    // exec-attributed portion evenly among those exec events.
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
    pendingExec.clear();
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
    if (!firstTimestamp) firstTimestamp = ts;
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
      if (obj.payload.name === "exec_command") {
        const args = safeJsonParse(obj.payload.arguments || "{}") || {};
        pendingExec.set(obj.payload.call_id || "", {
          cmd: String(args.cmd || ""),
          workdir: args.workdir ? String(args.workdir) : null,
        });
      }
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
    firstTimestamp,
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
  if (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return result;
}

module.exports = {
  computeCodexContextBreakdown,
};
