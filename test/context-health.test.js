"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeContextHealth, estimateTokens } = require("../src/lib/context-health");

test("context health returns counts and estimates without file content", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-context-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tt-context-project-"));
  fs.mkdirSync(path.join(home, ".claude", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "PRIVATE INSTRUCTION CONTENT");
  fs.writeFileSync(path.join(home, ".claude", "skills", "demo", "SKILL.md"), "skill words");
  fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { one: {}, two: {} } }));
  const result = computeContextHealth({ home, cwd, env: {} });
  assert.equal(result.breakdown.instruction_files, 1);
  assert.equal(result.breakdown.skills, 1);
  assert.equal(result.breakdown.mcp_servers, 2);
  assert.ok(result.estimated_fixed_tokens > 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE INSTRUCTION CONTENT"), false);
  assert.ok(estimateTokens("你好 world") >= 4);
});
