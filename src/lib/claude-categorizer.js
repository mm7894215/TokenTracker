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

// Token-saver-compatible tool categorization.
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
      name,
    )
  )
    return "Browser";

  if (/^(Read|Write|Edit|Glob)$/.test(name)) return "File Ops";
  if (name === "Grep") return "Search";
  if (name === "Bash") return "Execution";

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

function emptyToolBreakdown() {
  return {
    total_calls: 0,
    tools: [],
  };
}

function emptyCategoryMap() {
  const out = {};
  for (const key of CATEGORY_KEYS) out[key] = emptyTotals();
  return out;
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

function addInto(target, source) {
  target.input_tokens += source.input_tokens || 0;
  target.cached_input_tokens += source.cached_input_tokens || 0;
  target.cache_creation_input_tokens += source.cache_creation_input_tokens || 0;
  target.output_tokens += source.output_tokens || 0;
  target.reasoning_output_tokens += source.reasoning_output_tokens || 0;
  target.total_tokens += source.total_tokens || 0;
}

function extractExecCommands(content) {
  const commands = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "tool_use") continue;
    if (block.name !== "Bash" && block.name !== "exec_command") continue;
    const input = block.input || {};
    const command =
      typeof input.command === "string" ? input.command
      : typeof input.cmd === "string" ? input.cmd
      : "";
    if (command.trim()) commands.push(command.trim());
  }
  return commands;
}

function ensureExecRow(map, key) {
  const safeKey = key || "unknown";
  if (!map.has(safeKey)) map.set(safeKey, { name: safeKey, ...buildExecStatsEntry() });
  return map.get(safeKey);
}

function addExecTotals(row, totals) {
  row.calls += 1;
  addInto(row.totals, totals || {});
}

function recordExecCommandUsage(execLedger, commands, totals) {
  if (!execLedger || !Array.isArray(commands) || commands.length === 0) return;
  const perCommandRows = new Map();
  for (const command of commands) {
    if (!perCommandRows.has(command)) perCommandRows.set(command, { calls: 0 });
    perCommandRows.get(command).calls += 1;
  }
  const totalsByCommand = allocateTotalsAcrossRows(totals, perCommandRows);

  for (const [command, row] of perCommandRows.entries()) {
    const commandTotals = totalsByCommand.get(command) || {};
    const kind = inferExecCommandKind(command);
    const executable = getExecutableName(command);
    const signature = sanitizeCommandSignature(command);
    const exitKey = "unknown:unknown";

    const targets = [
      [execLedger.by_type, kind],
      [execLedger.by_executable, executable],
      [execLedger.by_command, signature],
      [execLedger.by_exit, exitKey],
    ];
    for (const [map, key] of targets) {
      const target = ensureExecRow(map, key);
      target.calls += Math.max(1, Number(row.calls || 0));
      addInto(target.totals, commandTotals);
    }
    execLedger.total_calls += Math.max(1, Number(row.calls || 0));
  }
}

function allocateTotalsAcrossRows(totals, rows) {
  const entries = Array.from(rows?.entries?.() || []);
  if (entries.length === 0) return new Map();
  const weights = {};
  const order = entries.map(([name]) => name).sort();
  for (const name of order) {
    const row = rows.get(name) || {};
    weights[name] = Math.max(0, Number(row.output_tokens || row.calls || 0));
  }
  if (order.every((name) => !weights[name])) {
    for (const name of order) weights[name] = 1;
  }
  const out = new Map();
  for (const name of order) out.set(name, emptyTotals());
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    const alloc = allocateByLargestRemainder(Math.max(0, Number(totals?.[key] || 0)), weights, order);
    for (const name of order) {
      out.get(name)[key] = alloc[name] || 0;
    }
  }
  return out;
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

function extractSkillNames(content) {
  const names = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "tool_use" || block.name !== "Skill") continue;
    const skill = typeof block.input?.skill === "string" ? block.input.skill.trim() : "";
    if (skill) names.push(skill);
  }
  return names;
}

function recordSkillUsage(skillLedger, skillNames, totals) {
  if (!skillLedger || !Array.isArray(skillNames) || skillNames.length === 0) return;
  const perMessageRows = new Map();
  for (const name of skillNames) {
    if (!perMessageRows.has(name)) perMessageRows.set(name, { calls: 0 });
    perMessageRows.get(name).calls += 1;
  }
  const totalsByName = allocateTotalsAcrossRows(totals, perMessageRows);
  for (const [name, row] of perMessageRows.entries()) {
    if (!skillLedger.by_name.has(name)) {
      skillLedger.by_name.set(name, { name, calls: 0, totals: emptyTotals() });
    }
    const target = skillLedger.by_name.get(name);
    target.calls += row.calls || 0;
    addInto(target.totals, totalsByName.get(name) || {});
  }
  skillLedger.total_calls += skillNames.length;
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

function computeOutputTokenBreakdown(usage, content) {
  const total = Math.max(0, Number(usage.output_tokens || 0));
  const reasoningExplicit = Math.max(0, Number(usage.reasoning_output_tokens || 0));
  const blocks = Array.isArray(content) ? content : [];

  if (total === 0) {
    return {
      bucket_tokens: { reasoning: 0, tool_calls: 0, subagents: 0, assistant_response: 0 },
      tool_calls: { total_calls: 0, by_name: new Map() },
      subagents: { total_calls: 0, by_name: new Map() },
    };
  }

  const bucketChars = { reasoning: 0, tool_calls: 0, subagents: 0, assistant_response: 0 };
  const toolCallChars = new Map();
  const subagentChars = new Map();
  const toolCallCounts = new Map();
  const subagentCounts = new Map();

  let totalChars = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    let chars = 0;

    if (type === "thinking") {
      chars = String(block.thinking || block.text || "").length || 1;
      bucketChars.reasoning += chars;
    } else if (type === "text") {
      chars = String(block.text || "").length || 1;
      bucketChars.assistant_response += chars;
    } else if (type === "tool_use") {
      const inputJson = block.input ? JSON.stringify(block.input) : "";
      chars = (block.name || "").length + inputJson.length + 1;
      if (SUBAGENT_TOOL_NAMES.has(block.name)) {
        bucketChars.subagents += chars;
        subagentChars.set(block.name, (subagentChars.get(block.name) || 0) + chars);
        subagentCounts.set(block.name, (subagentCounts.get(block.name) || 0) + 1);
      } else {
        bucketChars.tool_calls += chars;
        toolCallChars.set(block.name, (toolCallChars.get(block.name) || 0) + chars);
        toolCallCounts.set(block.name, (toolCallCounts.get(block.name) || 0) + 1);
      }
    } else {
      continue;
    }

    totalChars += chars;
  }

  if (totalChars === 0) {
    return {
      bucket_tokens: { reasoning: 0, tool_calls: 0, subagents: 0, assistant_response: total },
      tool_calls: { total_calls: 0, by_name: new Map() },
      subagents: { total_calls: 0, by_name: new Map() },
    };
  }

  const explicitReasoning = reasoningExplicit > 0 ? Math.min(reasoningExplicit, total) : 0;
  const nonReasoningOutput = total - explicitReasoning;

  const allocChars = { ...bucketChars };
  let allocTotalChars = totalChars;
  if (explicitReasoning > 0) {
    allocTotalChars -= allocChars.reasoning;
    allocChars.reasoning = 0;
  }

  const order = ["reasoning", "tool_calls", "subagents", "assistant_response"];
  const prorated = allocateByLargestRemainder(Math.max(0, nonReasoningOutput), allocChars, order);

  const bucketTokens = {
    reasoning: explicitReasoning + (prorated.reasoning || 0),
    tool_calls: prorated.tool_calls || 0,
    subagents: prorated.subagents || 0,
    assistant_response: prorated.assistant_response || 0,
  };

  if (allocTotalChars <= 0 && nonReasoningOutput > 0) {
    bucketTokens.reasoning = explicitReasoning;
    bucketTokens.tool_calls = 0;
    bucketTokens.subagents = 0;
    bucketTokens.assistant_response = nonReasoningOutput;
  }

  const toolTokensByName = new Map();
  if (bucketTokens.tool_calls > 0 && toolCallChars.size > 0) {
    const keys = [...toolCallChars.keys()].sort();
    const weights = {};
    for (const k of keys) weights[k] = toolCallChars.get(k) || 0;
    const alloc = allocateByLargestRemainder(bucketTokens.tool_calls, weights, keys);
    for (const k of keys) toolTokensByName.set(k, alloc[k] || 0);
  }

  const subagentTokensByName = new Map();
  if (bucketTokens.subagents > 0 && subagentChars.size > 0) {
    const keys = [...subagentChars.keys()].sort();
    const weights = {};
    for (const k of keys) weights[k] = subagentChars.get(k) || 0;
    const alloc = allocateByLargestRemainder(bucketTokens.subagents, weights, keys);
    for (const k of keys) subagentTokensByName.set(k, alloc[k] || 0);
  }

  return {
    bucket_tokens: bucketTokens,
    tool_calls: {
      total_calls: [...toolCallCounts.values()].reduce((a, b) => a + b, 0),
      by_name: new Map(
        [...toolCallCounts.entries()].map(([name, calls]) => [
          name,
          { name, calls, output_tokens: toolTokensByName.get(name) || 0 },
        ]),
      ),
    },
    subagents: {
      total_calls: [...subagentCounts.values()].reduce((a, b) => a + b, 0),
      by_name: new Map(
        [...subagentCounts.entries()].map(([name, calls]) => [
          name,
          { name, calls, output_tokens: subagentTokensByName.get(name) || 0 },
        ]),
      ),
    },
  };
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
  const out = computeOutputTokenBreakdown(usage, content);
  for (const key of ["reasoning", "tool_calls", "subagents", "assistant_response"]) {
    const tok = out.bucket_tokens[key] || 0;
    if (tok === 0) continue;
    breakdown[key].output_tokens += tok;
    breakdown[key].total_tokens += tok;
    if (key === "reasoning") breakdown[key].reasoning_output_tokens += tok;
  }
}

// Per-session state lets us pick out the *first* meaningful cache_creation
// chunk and call that the system_prefix. Subsequent cache_creations are
// incremental — we attribute them to conversation_history.
function classifyOneMessage(obj, sessionState, breakdown, toolLedger = null, skillLedger = null, execLedger = null) {
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

  recordSkillUsage(
    skillLedger,
    extractSkillNames(obj?.message?.content),
    {
      input_tokens: inputNonCached,
      cached_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: inputNonCached + cacheRead + cacheCreate + output,
    },
  );

  // Split output across reasoning / tool_calls / subagents / assistant_response.
  if (output > 0) {
    const out = computeOutputTokenBreakdown(
      { output_tokens: output, reasoning_output_tokens: usage.reasoning_output_tokens },
      obj?.message?.content,
    );
    for (const key of ["reasoning", "tool_calls", "subagents", "assistant_response"]) {
      const tok = out.bucket_tokens[key] || 0;
      if (tok === 0) continue;
      breakdown[key].output_tokens += tok;
      breakdown[key].total_tokens += tok;
      if (key === "reasoning") breakdown[key].reasoning_output_tokens += tok;
    }

    recordExecCommandUsage(
      execLedger,
      extractExecCommands(obj?.message?.content),
      {
        input_tokens: inputNonCached,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: out.bucket_tokens.tool_calls || 0,
        reasoning_output_tokens: 0,
        total_tokens: inputNonCached + cacheRead + cacheCreate + (out.bucket_tokens.tool_calls || 0),
      },
    );

    if (toolLedger) {
      const ledgerTotals = {
        input_tokens: inputNonCached,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: out.bucket_tokens.tool_calls || 0,
        reasoning_output_tokens: 0,
        total_tokens: inputNonCached + cacheRead + cacheCreate + (out.bucket_tokens.tool_calls || 0),
      };
      const toolTotalsByName = allocateTotalsAcrossRows(ledgerTotals, out.tool_calls.by_name);
      for (const [name, row] of out.tool_calls.by_name.entries()) {
        if (!toolLedger.tool_calls.by_name.has(name)) {
          toolLedger.tool_calls.by_name.set(name, { name, calls: 0, totals: emptyTotals() });
        }
        const target = toolLedger.tool_calls.by_name.get(name);
        target.calls += row.calls || 0;
        addInto(target.totals, toolTotalsByName.get(name) || {});
      }
      toolLedger.tool_calls.total_calls += out.tool_calls.total_calls || 0;

      const subagentTotals = {
        input_tokens: inputNonCached,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: out.bucket_tokens.subagents || 0,
        reasoning_output_tokens: 0,
        total_tokens: inputNonCached + cacheRead + cacheCreate + (out.bucket_tokens.subagents || 0),
      };
      const subagentTotalsByName = allocateTotalsAcrossRows(subagentTotals, out.subagents.by_name);
      for (const [name, row] of out.subagents.by_name.entries()) {
        if (!toolLedger.subagents.by_name.has(name)) {
          toolLedger.subagents.by_name.set(name, { name, calls: 0, totals: emptyTotals() });
        }
        const target = toolLedger.subagents.by_name.get(name);
        target.calls += row.calls || 0;
        addInto(target.totals, subagentTotalsByName.get(name) || {});
      }
      toolLedger.subagents.total_calls += out.subagents.total_calls || 0;
    }
  }
}

// Read one session jsonl streaming, in timestamp range, dedup by msgId+reqId.
async function categorizeSessionFile(filePath, { fromIso, toIso, seenHashes }, breakdown, toolLedger = null, skillLedger = null, execLedger = null) {
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

    classifyOneMessage(obj, sessionState, breakdown, toolLedger, skillLedger, execLedger);
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
const CACHE_SCHEMA_VERSION = "skills-exec-v2";

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

  const cacheKey = `${CACHE_SCHEMA_VERSION}|${root}|${from || ""}|${to || ""}|${files.length}|${maxMtimeMs(files)}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const { fromIso, toIso } = dayKeyToIsoBounds(from, to);
  const breakdown = emptyCategoryMap();
  const seenHashes = new Set();
  let messageCount = 0;
  let sessionCount = 0;
  const toolLedger = {
    tool_calls: { total_calls: 0, by_name: new Map() },
    subagents: { total_calls: 0, by_name: new Map() },
  };
  const skillLedger = { total_calls: 0, by_name: new Map() };
  const execLedger = {
    total_calls: 0,
    by_type: new Map(),
    by_executable: new Map(),
    by_command: new Map(),
    by_exit: new Map(),
  };

  for (const fp of files) {
    const counted = await categorizeSessionFile(
      fp,
      { fromIso, toIso, seenHashes },
      breakdown,
      toolLedger,
      skillLedger,
      execLedger,
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
    message_breakdown: buildMessageBreakdown(breakdown),
    tool_calls_breakdown: buildToolCallsBreakdown(toolLedger),
    skills_breakdown: buildSkillsBreakdown(skillLedger),
    exec_command_breakdown: buildExecCommandBreakdown(execLedger),
    configured_resources: getConfiguredResources({ projectDir }),
  };

  CACHE.set(cacheKey, { at: Date.now(), value: result });
  // Bound cache size — categorizer is cheap to recompute, no point hoarding.
  if (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return result;
}

function buildToolCallsBreakdown(toolLedger) {
  if (!toolLedger || !toolLedger.tool_calls || !toolLedger.subagents) {
    return {
      tool_calls: emptyToolBreakdown(),
      subagents: emptyToolBreakdown(),
    };
  }

  function mapToSortedRows(map) {
    const rows = Array.from(map.values()).map((row) => ({
      name: row.name,
      calls: row.calls,
      totals: row.totals || {
        ...emptyTotals(),
        output_tokens: row.output_tokens || 0,
        total_tokens: row.total_tokens || row.output_tokens || 0,
      },
    }));
    rows.sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
    return rows;
  }

  const toolCallsRows = mapToSortedRows(toolLedger.tool_calls.by_name || new Map());
  const subagentRows = mapToSortedRows(toolLedger.subagents.by_name || new Map());

  function groupIntoCategories(rows) {
    const byCategory = new Map(); // name -> {name,calls,totals,tools:[]}
    for (const row of rows) {
      const toolName = String(row?.name || "");
      if (!toolName) continue;
      const cat = categorizeTool(toolName);
      if (!byCategory.has(cat)) {
        byCategory.set(cat, {
          name: cat,
          calls: 0,
          totals: emptyTotals(),
          tools: [],
        });
      }
      const bucket = byCategory.get(cat);
      bucket.calls += Number(row.calls || 0);
      addInto(bucket.totals, row.totals || {});
      bucket.tools.push({
        name: toolName,
        calls: Number(row.calls || 0),
        totals: row.totals || emptyTotals(),
      });
    }
    const categories = Array.from(byCategory.values())
      .map((c) => ({
        name: c.name,
        calls: Math.round(c.calls || 0),
        totals: {
          input_tokens: Math.round(c.totals.input_tokens || 0),
          cached_input_tokens: Math.round(c.totals.cached_input_tokens || 0),
          cache_creation_input_tokens: Math.round(c.totals.cache_creation_input_tokens || 0),
          output_tokens: Math.round(c.totals.output_tokens || 0),
          reasoning_output_tokens: Math.round(c.totals.reasoning_output_tokens || 0),
          total_tokens: Math.round(c.totals.total_tokens || 0),
        },
        tools: c.tools
          .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0))
          .map((t) => ({
            name: t.name,
            calls: Math.round(t.calls || 0),
            totals: {
              input_tokens: Math.round(t.totals.input_tokens || 0),
              cached_input_tokens: Math.round(t.totals.cached_input_tokens || 0),
              cache_creation_input_tokens: Math.round(t.totals.cache_creation_input_tokens || 0),
              output_tokens: Math.round(t.totals.output_tokens || 0),
              reasoning_output_tokens: Math.round(t.totals.reasoning_output_tokens || 0),
              total_tokens: Math.round(t.totals.total_tokens || 0),
            },
          })),
      }))
      .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
    return categories;
  }

  return {
    tool_calls: {
      total_calls: toolLedger.tool_calls.total_calls || 0,
      tools: toolCallsRows,
      categories: groupIntoCategories(toolCallsRows),
    },
    subagents: {
      total_calls: toolLedger.subagents.total_calls || 0,
      tools: subagentRows,
      categories: groupIntoCategories(subagentRows),
    },
    privacy: {
      includes_inputs: false,
      note: "Aggregated tool names only; tool inputs are never recorded.",
    },
  };
}

function buildSkillsBreakdown(skillLedger) {
  const rows = Array.from(skillLedger?.by_name?.values?.() || [])
    .map((row) => ({
      name: row.name,
      calls: Math.round(row.calls || 0),
      totals: roundTotals(row.totals || emptyTotals()),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  return {
    total_calls: Math.round(skillLedger?.total_calls || 0),
    skills: rows,
    privacy: {
      includes_inputs: false,
      note: "Aggregated skill names only; skill inputs are never returned.",
    },
  };
}

function serializeExecRows(map) {
  return Array.from(map?.values?.() || [])
    .map((row) => ({
      name: row.name,
      calls: Math.round(row.calls || 0),
      failures: Math.round(row.failures || 0),
      duration_ms: Math.round(row.duration_ms || 0),
      max_duration_ms: Math.round(row.max_duration_ms || 0),
      output_chars: Math.round(row.output_chars || 0),
      output_lines: Math.round(row.output_lines || 0),
      totals: roundTotals(row.totals || emptyTotals()),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function buildExecCommandBreakdown(execLedger) {
  return {
    total_calls: Math.round(execLedger?.total_calls || 0),
    by_type: serializeExecRows(execLedger?.by_type),
    by_executable: serializeExecRows(execLedger?.by_executable),
    by_command: serializeExecRows(execLedger?.by_command),
    by_duration: [],
    by_output: [],
    by_exit: serializeExecRows(execLedger?.by_exit),
    privacy: {
      includes_commands: false,
      note: "Claude Bash commands are grouped into sanitized signatures; raw commands are not returned.",
    },
  };
}

function buildMessageBreakdown(breakdown) {
  const rows = [
    {
      key: "user_input",
      name: "User input",
      totals: breakdown.user_input || emptyTotals(),
    },
    {
      key: "conversation_history",
      name: "Conversation history",
      totals: breakdown.conversation_history || emptyTotals(),
    },
    {
      key: "assistant_response",
      name: "Assistant response",
      totals: breakdown.assistant_response || emptyTotals(),
    },
  ];

  return {
    categories: rows
      .map((row) => ({
        key: row.key,
        name: row.name,
        totals: {
          input_tokens: Math.round(row.totals.input_tokens || 0),
          cached_input_tokens: Math.round(row.totals.cached_input_tokens || 0),
          cache_creation_input_tokens: Math.round(row.totals.cache_creation_input_tokens || 0),
          output_tokens: Math.round(row.totals.output_tokens || 0),
          reasoning_output_tokens: Math.round(row.totals.reasoning_output_tokens || 0),
          total_tokens: Math.round(row.totals.total_tokens || 0),
        },
      }))
      .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0)),
    privacy: {
      includes_content: false,
      note: "Aggregated message token categories only; prompt and assistant text are never returned.",
    },
  };
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
