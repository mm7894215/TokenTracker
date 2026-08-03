const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  repairCodebuddyLogJsonlOverlap,
  CODEBUDDY_LOG_JSONL_REPAIR_KEY,
} = require("../src/commands/sync");

test("repairCodebuddyLogJsonlOverlap rebuilds old log+JSONL double counts atomically", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-repair-"));
  try {
    const codebuddyHome = path.join(tmp, ".codebuddy");
    const projectDir = path.join(codebuddyHome, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, "session.jsonl");
    const logPath = path.join(tmp, "extension.log");
    const hourStart = "2026-04-05T14:00:00.000Z";
    const jsonlLine = JSON.stringify({
      type: "function_call",
      sessionId: "session",
      providerData: {
        messageId: "round-trip-1",
        model: "hy3",
        rawUsage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
      timestamp: Date.parse(hourStart),
    });
    await fs.writeFile(jsonlPath, `${jsonlLine}\n`);
    await fs.writeFile(logPath, "legacy log source\n");

    const queuePath = path.join(tmp, "queue.jsonl");
    const queueRows = [
      { source: "other", model: "x", hour_start: hourStart, total_tokens: 7 },
      {
        source: "codebuddy",
        model: "hy3",
        hour_start: hourStart,
        input_tokens: 200,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
        total_tokens: 220,
        conversation_count: 2,
      },
    ];
    await fs.writeFile(queuePath, queueRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const queueStatePath = path.join(tmp, "queue.state.json");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }));

    const cursors = {
      version: 1,
      hourly: {
        buckets: {
          "codebuddy|hy3|2026-04-05T14:00:00.000Z": {
            source: "codebuddy",
            model: "hy3",
            hour_start: hourStart,
            totals: {
              input_tokens: 200,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 220,
              conversation_count: 2,
            },
          },
        },
        groupQueued: {},
      },
      codebuddy: {
        fileOffsets: {
          [jsonlPath]: { size: 1 },
          [logPath]: { size: 1 },
        },
      },
    };

    const changed = await repairCodebuddyLogJsonlOverlap({
      cursors,
      queuePath,
      queueStatePath,
      codebuddyFiles: [jsonlPath, logPath],
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: tmp },
    });
    assert.equal(changed, true);
    assert.equal(cursors.migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY].status, "applied");
    assert.equal(cursors.hourly.buckets["codebuddy|hy3|2026-04-05T14:00:00.000Z"].totals.total_tokens, 110);
    assert.equal(typeof cursors.codebuddy.fileOffsets[logPath]?.size, "number");

    const lines = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.filter((row) => row.source === "other").length, 1);
    const codebuddyRows = lines.filter((row) => row.source === "codebuddy");
    assert.equal(codebuddyRows.length, 1);
    assert.equal(codebuddyRows[0].total_tokens, 110);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);

    const changedAgain = await repairCodebuddyLogJsonlOverlap({
      cursors,
      queuePath,
      queueStatePath,
      codebuddyFiles: [jsonlPath, logPath],
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: tmp },
    });
    assert.equal(changedAgain, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("repairCodebuddyLogJsonlOverlap preserves distinct legacy log rounds", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codebuddy-repair-mixed-"));
  try {
    const codebuddyHome = path.join(tmp, ".codebuddy");
    const projectDir = path.join(codebuddyHome, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(codebuddyHome, "settings.json"), JSON.stringify({ model: "kimi-k2.7" }));
    const jsonlPath = path.join(projectDir, "session.jsonl");
    const logPath = path.join(tmp, "extension.log");
    const hourStart = new Date(Date.parse("2026-07-01T16:30:00.000")).toISOString();
    await fs.writeFile(jsonlPath, JSON.stringify({
      id: "jsonl-row",
      timestamp: Date.parse("2026-07-01T16:56:02.200"),
      sessionId: "session-1",
      providerData: {
        messageId: "response-1",
        model: "kimi-k2.7",
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }) + "\n");
    await fs.writeFile(logPath, [
      "[2026/7/1 16:56:01.100] [info] [CraftInvokableAgent] [agent-1] Model prepared: Kimi-K2.7-Code (kimi-k2.7)",
      '[2026/7/1 16:56:02.200] [info] [AgentReporter] [agent-1] Agent execution successful with usage: {"inputTokens":1000,"outputTokens":100,"totalTokens":1100}',
      '[2026/7/1 16:56:05.200] [info] [AgentReporter] [agent-2] Agent execution successful with usage: {"inputTokens":500,"outputTokens":50,"totalTokens":550}',
    ].join("\n") + "\n");

    const queuePath = path.join(tmp, "queue.jsonl");
    const oldTotal = 1100 + 1100 + 550;
    await fs.writeFile(queuePath, JSON.stringify({
      source: "codebuddy",
      model: "kimi-k2.7",
      hour_start: hourStart,
      input_tokens: oldTotal,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: oldTotal,
      conversation_count: 3,
    }) + "\n");
    const queueStatePath = path.join(tmp, "queue.state.json");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 42 }));
    const cursors = {
      version: 1,
      hourly: {
        buckets: {
          [`codebuddy|kimi-k2.7|${hourStart}`]: {
            source: "codebuddy",
            model: "kimi-k2.7",
            hour_start: hourStart,
            totals: {
              input_tokens: oldTotal,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: oldTotal,
              conversation_count: 3,
            },
          },
        },
        groupQueued: {},
      },
      codebuddy: { fileOffsets: { [jsonlPath]: { size: 1 }, [logPath]: { size: 1 } } },
    };

    const changed = await repairCodebuddyLogJsonlOverlap({
      cursors,
      queuePath,
      queueStatePath,
      codebuddyFiles: [jsonlPath, logPath],
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: tmp },
    });
    assert.equal(changed, true);
    assert.equal(
      cursors.hourly.buckets[`codebuddy|kimi-k2.7|${hourStart}`].totals.total_tokens,
      1650,
    );
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.source === "codebuddy")[0].total_tokens, 1650);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
