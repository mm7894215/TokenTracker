"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseGrokBuildIncremental,
  resolveGrokBuildSessions,
} = require("../src/lib/rollout");
const { computeRowCost, ensurePricingLoaded, getModelPricing } = require("../src/lib/pricing");

function makeSession({
  sessionId = "019f0000-test-session",
  model = "grok-4.5",
  turns = [],
  contextMetas = [],
  signals = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-parser-"));
  const encodedCwd = encodeURIComponent("/tmp/project");
  const sessionDir = path.join(root, "sessions", encodedCwd, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const lines = [];
  let eventN = 1;
  for (const totalTokens of contextMetas) {
    lines.push(
      JSON.stringify({
        timestamp: 1784357000 + eventN,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "..." },
          },
          _meta: {
            totalTokens,
            eventId: `${sessionId}-${eventN}`,
            agentTimestampMs: 1784357000000 + eventN * 1000,
            updateType: "AgentThoughtChunk",
          },
        },
      }),
    );
    eventN += 1;
  }
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        timestamp: 1784357000 + eventN,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: turn.promptId || `prompt-${eventN}`,
            stop_reason: "end_turn",
            usage: turn.usage,
          },
          _meta: {
            totalTokens: turn.contextWindowTokens ?? 12_000,
            eventId: `${sessionId}-${eventN}`,
            agentTimestampMs: turn.timestampMs || 1784357100000 + eventN * 1000,
          },
        },
      }),
    );
    eventN += 1;
  }

  fs.writeFileSync(path.join(sessionDir, "updates.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(sessionDir, "signals.json"),
    JSON.stringify({
      primaryModelId: model,
      modelsUsed: [model],
      assistantMessageCount: turns.length || 1,
      contextTokensUsed: signals.contextTokensUsed ?? 50_000,
      totalTokensBeforeCompaction: signals.totalTokensBeforeCompaction ?? 0,
      lastActiveAt: "2026-07-18T10:00:00.000Z",
      ...signals,
    }),
  );
  fs.writeFileSync(
    path.join(sessionDir, "summary.json"),
    JSON.stringify({ updated_at: "2026-07-18T10:00:00.000Z" }),
  );

  return {
    root,
    sessionDir,
    sessionId,
    env: { TOKENTRACKER_GROK_HOME: root, GROK_HOME: root },
  };
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function dedupeQueue(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row.source !== "grok") continue;
    seen.set(`${row.model}|${row.hour_start}`, row);
  }
  return [...seen.values()];
}

test("parseGrokBuildIncremental prefers turn_completed.usage over context-window totalTokens", async () => {
  const fixture = makeSession({
    contextMetas: [10_000, 40_000, 90_000],
    turns: [
      {
        usage: {
          inputTokens: 100_000,
          outputTokens: 500,
          totalTokens: 100_500,
          cachedReadTokens: 20_000,
          reasoningTokens: 100,
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 100_000,
              outputTokens: 500,
              totalTokens: 100_500,
              cachedReadTokens: 20_000,
              reasoningTokens: 100,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T10:05:00.000Z"),
      },
      {
        usage: {
          inputTokens: 50_000,
          outputTokens: 200,
          totalTokens: 50_200,
          cachedReadTokens: 10_000,
          reasoningTokens: 40,
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 50_000,
              outputTokens: 200,
              totalTokens: 50_200,
              cachedReadTokens: 10_000,
              reasoningTokens: 40,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T10:20:00.000Z"),
      },
    ],
    signals: { contextTokensUsed: 90_000, totalTokensBeforeCompaction: 200_000 },
  });

  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 3 },
  };
  const result = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });

  assert.equal(result.eventsAggregated, 2);
  assert.equal(cursors.grok.version, 4);

  const snap = cursors.grok.sessionSnapshots[fixture.sessionId];
  assert.ok(snap);
  assert.equal(snap.source, "turn_usage");
  assert.equal(snap.totalTokens, 150_700);

  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.model, "grok-4.5-build");
  assert.equal(row.total_tokens, 150_700);
  assert.equal(row.input_tokens, 120_000);
  assert.equal(row.cached_input_tokens, 30_000);
  assert.equal(row.output_tokens, 700);
  assert.equal(row.reasoning_output_tokens, 140);
  assert.equal(row.conversation_count, 2);
});

test("parseGrokBuildIncremental canonicalizes free Build SKU so pricing stays $0", async () => {
  await ensurePricingLoaded();
  assert.equal(getModelPricing("grok-build-free", { source: "grok" }).input, 0);
  assert.equal(getModelPricing("grok-4.5-build-free", { source: "grok" }).input, 0);
  assert.equal(getModelPricing("grok-4.5-build", { source: "grok" }).input, 2);

  const fixture = makeSession({
    turns: [
      {
        usage: {
          inputTokens: 21219,
          outputTokens: 102,
          totalTokens: 21321,
          cachedReadTokens: 1280,
          reasoningTokens: 54,
          modelUsage: {
            "grok-4.5-build-free": {
              inputTokens: 21219,
              outputTokens: 102,
              totalTokens: 21321,
              cachedReadTokens: 1280,
              reasoningTokens: 54,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T11:00:00.000Z"),
      },
    ],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };
  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "grok-build-free");
  assert.equal(computeRowCost(rows[0]), 0);
});

test("parseGrokBuildIncremental falls back to context watermark only without turn_completed", async () => {
  const fixture = makeSession({
    turns: [],
    contextMetas: [5_000, 12_000, 8_000, 20_000],
    signals: { contextTokensUsed: 18_000, totalTokensBeforeCompaction: 0 },
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };
  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const snap = cursors.grok.sessionSnapshots[fixture.sessionId];
  assert.ok(snap);
  assert.equal(snap.source, "updates");
  assert.equal(snap.totalTokens, 20_000);
  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 20_000);
  assert.equal(rows[0].input_tokens + rows[0].output_tokens, 20_000);
});

test("v3 -> v4 migration rebuilds from turn usage and does not keep old watermark totals", async () => {
  const fixture = makeSession({
    turns: [
      {
        usage: {
          inputTokens: 80_000,
          outputTokens: 1_000,
          totalTokens: 81_000,
          cachedReadTokens: 0,
          modelUsage: {
            "grok-4.5": {
              inputTokens: 80_000,
              outputTokens: 1_000,
              totalTokens: 81_000,
              cachedReadTokens: 0,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T12:00:00.000Z"),
      },
    ],
    contextMetas: [9_000],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: {
      version: 3,
      buckets: {
        "grok|grok-4.5|2026-07-18T12:00:00.000Z": {
          totals: {
            input_tokens: 7200,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 1800,
            reasoning_output_tokens: 0,
            total_tokens: 9000,
            billable_total_tokens: 9000,
            conversation_count: 1,
          },
          queuedKey: "x",
        },
      },
      groupQueued: {},
    },
    grok: {
      version: 3,
      sessionSnapshots: {
        [fixture.sessionId]: {
          totalTokens: 9000,
          messageCount: 1,
          model: "grok-4.5",
          source: "updates",
          updatedAt: "2026-07-18T12:00:00.000Z",
        },
      },
    },
  };
  fs.writeFileSync(
    queuePath,
    `${JSON.stringify({
      source: "grok",
      model: "grok-4.5",
      hour_start: "2026-07-18T12:00:00.000Z",
      input_tokens: 7200,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 1800,
      reasoning_output_tokens: 0,
      total_tokens: 9000,
      billable_total_tokens: 9000,
      conversation_count: 1,
    })}\n`,
  );

  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });

  assert.equal(cursors.grok.version, 4);
  assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 81_000);
  const rows = dedupeQueue(readQueue(queuePath));
  const row = rows.find((r) => r.model === "grok-4.5");
  assert.ok(row);
  assert.equal(row.total_tokens, 81_000);
  assert.equal(row.input_tokens, 80_000);
  assert.equal(row.output_tokens, 1_000);
});
