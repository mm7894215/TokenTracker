"use strict";

// Estimates fixed context overhead without returning file contents, prompts,
// tool schemas, secrets, or command arguments.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contextCache = new Map();

function estimateTokens(text) {
  const value = String(text || "");
  let cjk = 0;
  for (const char of value) if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)) cjk += 1;
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

function readMetadata(filePath, kind, root) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return { kind, name: path.relative(root, filePath) || path.basename(filePath), bytes: Buffer.byteLength(text), estimated_tokens: estimateTokens(text) };
  } catch { return null; }
}

function walkNamedFiles(root, targetName, limit = 500) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && entry.name === targetName) out.push(filePath);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function countMcpServers(home, cwd) {
  const files = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".mcp.json"),
  ];
  const names = new Set();
  for (const filePath of files) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const servers = data.mcpServers || data.mcp_servers || {};
      for (const name of Object.keys(servers)) names.add(name);
    } catch { /* absent or not JSON */ }
  }
  try {
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    for (const match of toml.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)) names.add(match[1]);
  } catch { /* absent */ }
  return names.size;
}

function computeContextHealth({ home = os.homedir(), cwd = process.cwd(), env = process.env, cacheTtlMs = 5 * 60_000 } = {}) {
  const cacheKey = `${home}\0${cwd}\0${env.TOKENTRACKER_MCP_TOOL_SCHEMA_TOKENS || ""}\0${env.TOKENTRACKER_MCP_TOOLS_PER_SERVER || ""}`;
  const cached = contextCache.get(cacheKey);
  if (cached && Date.now() - cached.at < cacheTtlMs) return cached.value;
  const files = [];
  const known = [
    [path.join(home, ".claude", "CLAUDE.md"), "instruction", home],
    [path.join(home, ".codex", "AGENTS.md"), "instruction", home],
    [path.join(cwd, "CLAUDE.md"), "instruction", cwd],
    [path.join(cwd, "AGENTS.md"), "instruction", cwd],
  ];
  for (const [filePath, kind, root] of known) {
    const item = readMetadata(filePath, kind, root);
    if (item) files.push(item);
  }
  const skillRoots = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
  for (const root of skillRoots) {
    for (const filePath of walkNamedFiles(root, "SKILL.md")) {
      const item = readMetadata(filePath, "skill", root);
      if (item) files.push(item);
    }
  }
  const instructionTokens = files.filter((row) => row.kind === "instruction").reduce((sum, row) => sum + row.estimated_tokens, 0);
  const skillTokens = files.filter((row) => row.kind === "skill").reduce((sum, row) => sum + row.estimated_tokens, 0);
  const mcpServers = countMcpServers(home, cwd);
  const perToolSchemaTokens = Math.max(0, Number(env.TOKENTRACKER_MCP_TOOL_SCHEMA_TOKENS || 400));
  const assumedToolsPerServer = Math.max(1, Number(env.TOKENTRACKER_MCP_TOOLS_PER_SERVER || 5));
  const mcpSchemaTokens = mcpServers * perToolSchemaTokens * assumedToolsPerServer;
  const total = instructionTokens + skillTokens + mcpSchemaTokens;
  const severity = total >= 50_000 ? "high" : total >= 20_000 ? "medium" : "low";
  const result = {
    generated_at: new Date().toISOString(),
    estimated_fixed_tokens: total,
    severity,
    breakdown: {
      instruction_files: files.filter((row) => row.kind === "instruction").length,
      instruction_tokens: instructionTokens,
      skills: files.filter((row) => row.kind === "skill").length,
      skill_tokens: skillTokens,
      mcp_servers: mcpServers,
      mcp_schema_tokens: mcpSchemaTokens,
    },
    largest_items: files.sort((a, b) => b.estimated_tokens - a.estimated_tokens).slice(0, 10),
    provenance: {
      confidence: "inferred",
      source: "local-config-metadata",
      mcp_assumption: { tools_per_server: assumedToolsPerServer, tokens_per_tool_schema: perToolSchemaTokens },
      content_retained: false,
    },
  };
  contextCache.set(cacheKey, { at: Date.now(), value: result });
  if (contextCache.size > 8) contextCache.delete(contextCache.keys().next().value);
  return result;
}

module.exports = { estimateTokens, computeContextHealth, countMcpServers };
