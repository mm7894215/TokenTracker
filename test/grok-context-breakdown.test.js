"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  computeGrokContextBreakdown,
  mapGrokToolName,
  readUsageTotals,
} = require("../src/lib/grok-context-breakdown");

test("mapGrokToolName normalizes Grok Build tool ids to Claude-like names", () => {
  assert.equal(mapGrokToolName("read_file"), "Read");
  assert.equal(mapGrokToolName("search_replace"), "Edit");
  assert.equal(mapGrokToolName("run_terminal_command"), "Bash");
  assert.equal(mapGrokToolName("grep"), "Grep");
});

test("readUsageTotals splits cache-inclusive inputTokens", () => {
  const totals = readUsageTotals({
    inputTokens: 1000,
    outputTokens: 50,
    totalTokens: 1050,
    cachedReadTokens: 400,
    reasoningTokens: 20,
  });
  assert.equal(totals.input_tokens, 600);
  assert.equal(totals.cached_input_tokens, 400);
  assert.equal(totals.output_tokens, 50);
  assert.equal(totals.reasoning_output_tokens, 20);
  assert.equal(totals.total_tokens, 1050);
});

function writeSession(root, sessionId, lines) {
  const encoded = encodeURIComponent("/tmp/project");
  const dir = path.join(root, "sessions", encoded, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "updates.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

test("computeGrokContextBreakdown attributes turn usage to tools like Codex", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-ctx-"));
  const sid = "019f-grok-ctx-1";
  const ts = Date.parse("2026-07-18T10:05:00.000Z");
  const lines = [
    JSON.stringify({
      timestamp: 1784357100,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "read_file",
          rawInput: { target_file: "a.ts" },
          _meta: { "x.ai/tool": { name: "read_file", kind: "read" } },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts,
          updateType: "ToolCall",
        },
      },
    }),
    JSON.stringify({
      timestamp: 1784357101,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c2",
          title: "run_terminal_command",
          rawInput: { command: "npm test" },
          _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts + 1000,
          updateType: "ToolCall",
        },
      },
    }),
    JSON.stringify({
      timestamp: 1784357110,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            totalTokens: 1100,
            cachedReadTokens: 200,
            reasoningTokens: 40,
            modelUsage: {
              "grok-4.5-build": {
                inputTokens: 1000,
                outputTokens: 100,
                totalTokens: 1100,
                cachedReadTokens: 200,
                reasoningTokens: 40,
              },
            },
          },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts + 10_000,
          totalTokens: 12_000,
        },
      },
    }),
  ];
  writeSession(root, sid, lines);

  const result = await computeGrokContextBreakdown({
    from: "2026-07-18",
    to: "2026-07-18",
    env: { GROK_HOME: root, TOKENTRACKER_GROK_HOME: root },
  });

  assert.equal(result.source, "grok");
  assert.equal(result.scope, "supported");
  assert.equal(result.totals.total_tokens, 1100);
  assert.equal(result.totals.input_tokens, 800);
  assert.equal(result.totals.cached_input_tokens, 200);
  assert.equal(result.totals.output_tokens, 100);
  assert.equal(result.totals.reasoning_output_tokens, 40);
  assert.equal(result.session_count, 1);
  assert.equal(result.message_count, 1);

  const tools = result.tool_calls_breakdown.tools;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["Bash", "Read"]);
  for (const t of tools) {
    assert.equal(Math.round(t.totals.total_tokens), 550);
  }

  assert.ok(result.tool_calls_breakdown.categories.length > 0);
  assert.ok(Array.isArray(result.exec_command_breakdown.by_type));
  assert.ok(result.message_breakdown.categories.length >= 2);
});

test("computeGrokContextBreakdown returns empty supported payload without sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-ctx-empty-"));
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const result = await computeGrokContextBreakdown({
    env: { GROK_HOME: root, TOKENTRACKER_GROK_HOME: root },
  });
  assert.equal(result.scope, "supported");
  assert.equal(result.totals.total_tokens, 0);
  assert.equal(result.session_count, 0);
});


test("computeGrokContextBreakdown reuses result cache on identical range", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-cache-"));
  const sid = "019f-grok-cache-1";
  const ts = Date.parse("2026-07-18T10:05:00.000Z");
  writeSession(root, sid, [
    JSON.stringify({
      timestamp: 1784357110,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 500,
            outputTokens: 50,
            totalTokens: 550,
            cachedReadTokens: 100,
            reasoningTokens: 10,
          },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts + 1000,
          updateType: "TurnCompleted",
        },
      },
    }),
  ]);

  const env = { GROK_HOME: root, HOME: root };
  const a = await computeGrokContextBreakdown({
    from: "2026-07-18",
    to: "2026-07-18",
    env,
  });
  const b = await computeGrokContextBreakdown({
    from: "2026-07-18",
    to: "2026-07-18",
    env,
  });
  assert.equal(a.totals.total_tokens, 550);
  assert.equal(b.totals.total_tokens, 550);
  assert.equal(a.session_count, b.session_count);
  // Same object from result cache (not a deep clone).
  assert.equal(a, b);
});

test("computeGrokContextBreakdown coalesces concurrent in-flight scans", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-inflight-"));
  const sid = "019f-grok-inflight-1";
  const ts = Date.parse("2026-07-19T10:05:00.000Z");
  writeSession(root, sid, [
    JSON.stringify({
      timestamp: 1784443510,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 200,
            outputTokens: 20,
            totalTokens: 220,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts + 500,
          updateType: "TurnCompleted",
        },
      },
    }),
  ]);

  const env = { GROK_HOME: root, HOME: root };
  const opts = { from: "2026-07-19", to: "2026-07-19", env };
  const [a, b] = await Promise.all([
    computeGrokContextBreakdown(opts),
    computeGrokContextBreakdown(opts),
  ]);
  assert.equal(a.totals.total_tokens, 220);
  assert.equal(b.totals.total_tokens, 220);
  assert.equal(a, b);
});

test("file parse cache invalidates when updates.jsonl size/mtime change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-filecache-"));
  const sid = "019f-grok-filecache-1";
  const ts = Date.parse("2026-07-20T10:05:00.000Z");
  const line = (total) =>
    JSON.stringify({
      timestamp: 1784529910,
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: total,
            outputTokens: 0,
            totalTokens: total,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        _meta: {
          promptId: "p1",
          turnStartMs: ts,
          agentTimestampMs: ts + 500,
          updateType: "TurnCompleted",
        },
      },
    });

  writeSession(root, sid, [line(100)]);
  const env = { GROK_HOME: root, HOME: root };
  const first = await computeGrokContextBreakdown({
    from: "2026-07-20",
    to: "2026-07-20",
    env,
  });
  assert.equal(first.totals.total_tokens, 100);

  // Append a second turn so size+mtime change → file cache miss, new totals.
  const updatesPath = path.join(
    root,
    "sessions",
    encodeURIComponent("/tmp/project"),
    sid,
    "updates.jsonl",
  );
  fs.appendFileSync(updatesPath, `${line(50)}\n`);
  // Ensure mtime advances on coarse FS clocks.
  const st = fs.statSync(updatesPath);
  fs.utimesSync(updatesPath, st.atime, new Date(st.mtimeMs + 2000));

  const second = await computeGrokContextBreakdown({
    from: "2026-07-20",
    to: "2026-07-20",
    env,
  });
  assert.equal(second.totals.total_tokens, 150);
});
