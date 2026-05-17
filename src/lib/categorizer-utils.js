// Shared helpers for claude-categorizer.js and codex-context-breakdown.js.
// Extracted to eliminate copy-paste between the two files.

"use strict";

const path = require("node:path");

// ---------------------------------------------------------------------------
// Tool categorizer
// ---------------------------------------------------------------------------

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

  // Claude Code built-in tools (also harmless to match from Codex side).
  if (/^(Read|Write|Edit|Glob)$/.test(name)) return "File Ops";
  if (name === "Grep") return "Search";
  if (name === "Bash") return "Execution";

  if (name.includes("<tool_call>") || name.includes("<arg_")) return "Malformed";

  return "Other";
}

// ---------------------------------------------------------------------------
// Shell command helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Token totals helpers
// ---------------------------------------------------------------------------

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

function addInto(target, source) {
  target.input_tokens += source.input_tokens || 0;
  target.cached_input_tokens += source.cached_input_tokens || 0;
  target.cache_creation_input_tokens += source.cache_creation_input_tokens || 0;
  target.output_tokens += source.output_tokens || 0;
  target.reasoning_output_tokens += source.reasoning_output_tokens || 0;
  target.total_tokens += source.total_tokens || 0;
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

// ---------------------------------------------------------------------------
// Integer allocation
// ---------------------------------------------------------------------------

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

module.exports = {
  categorizeTool,
  inferExecCommandKind,
  shellWords,
  unwrapShellCommand,
  sanitizeCommandSignature,
  getExecutableName,
  emptyTotals,
  addInto,
  roundTotals,
  buildExecStatsEntry,
  allocateByLargestRemainder,
};
