const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  repairWorkbuddyContextUsage,
  WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY,
} = require("../src/commands/sync");

test("repairWorkbuddyContextUsage retracts context-only SQLite history and rebuilds JSONL usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-repair-"));
  try {
    const workbuddyHome = path.join(tmp, ".workbuddy");
    const projectDir = path.join(workbuddyHome, "projects", "encoded-cwd");
    await fs.mkdir(projectDir, { recursive: true });
    const dbPath = path.join(workbuddyHome, "workbuddy.db");
    childProcess.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('wb-sess','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('wb-sess',100,192000,1780000000000,'{}');",
      ].join(" "),
    ]);

    const sessionFile = path.join(projectDir, "wb-sess.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({
      id: "response-1",
      type: "function_call",
      timestamp: Date.UTC(2026, 3, 5, 14, 0, 0),
      sessionId: "wb-sess",
      providerData: {
        messageId: "response-1",
        model: "hy3",
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }) + "\n");

    const hourStart = "2026-04-05T14:00:00.000Z";
    const staleKey = `workbuddy|auto|${hourStart}`;
    const queuePath = path.join(tmp, "queue.jsonl");
    await fs.writeFile(queuePath, JSON.stringify({
      source: "workbuddy",
      model: "auto",
      hour_start: hourStart,
      input_tokens: 100,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 100,
      conversation_count: 1,
    }) + "\n");
    const queueStatePath = path.join(tmp, "queue.state.json");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 42 }));

    const cursors = {
      version: 1,
      hourly: {
        buckets: {
          [staleKey]: {
            source: "workbuddy",
            model: "auto",
            hour_start: hourStart,
            totals: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 100,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
      workbuddy: {
        fileOffsets: { [sessionFile]: { size: 1 } },
        sqliteSessions: {
          "wb-sess": { used: 100, updatedAt: 1780000000000, model: "auto", detailed: false },
        },
      },
    };

    const changed = await repairWorkbuddyContextUsage({
      cursors,
      queuePath,
      queueStatePath,
      workbuddyFiles: [sessionFile],
      env: { WORKBUDDY_HOME: workbuddyHome, HOME: tmp },
    });
    assert.equal(changed, true);
    assert.equal(cursors.migrations[WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY].status, "applied");
    assert.equal(cursors.hourly.buckets[staleKey], undefined);

    const rebuiltKey = "workbuddy|hy3|2026-04-05T14:00:00.000Z";
    assert.equal(cursors.hourly.buckets[rebuiltKey].totals.total_tokens, 1100);
    const rows = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    const rebuiltRow = rows.find((row) => row.model === "hy3");
    const staleRetraction = rows.find((row) => row.model === "auto");
    assert.equal(rebuiltRow.total_tokens, 1100);
    assert.equal(staleRetraction.total_tokens, 0);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);

    const changedAgain = await repairWorkbuddyContextUsage({
      cursors,
      queuePath,
      queueStatePath,
      workbuddyFiles: [sessionFile],
      env: { WORKBUDDY_HOME: workbuddyHome, HOME: tmp },
    });
    assert.equal(changedAgain, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
