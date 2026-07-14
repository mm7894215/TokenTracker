"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_e) { }

const {
  resolveAnythingllmDbPath,
  parseAnythingllmTimestamp,
  readAnythingllmUsageRows,
  parseAnythingllmIncremental,
} = require("../src/lib/rollout");

const TRACKER = path.resolve(__dirname, "..", "bin", "tracker.js");

function createAnythingllmDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-test-"));
  const dbPath = path.join(dir, "anythingllm.db");
  executeSql(dbPath, `
    CREATE TABLE workspace_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspaceId INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      include BOOLEAN DEFAULT true,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      lastUpdatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { dir, dbPath };
}

function executeSql(dbPath, sql) {
  if (typeof DatabaseSync === "function") {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  cp.execFileSync("sqlite3", [dbPath, sql]);
}

function sqlValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertChat(dbPath, { prompt, response, createdAt, include = true }) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  executeSql(dbPath, `
    INSERT INTO workspace_chats (workspaceId, prompt, response, include, createdAt, lastUpdatedAt)
    VALUES (1, ${quote(prompt)}, ${quote(response)}, ${include ? 1 : 0}, ${sqlValue(createdAt)}, ${sqlValue(createdAt)});
  `);
}

function updateChatResponse(dbPath, id, response, lastUpdatedAt) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  executeSql(dbPath, `
    UPDATE workspace_chats
    SET response = ${quote(response)}, include = 1, lastUpdatedAt = ${sqlValue(lastUpdatedAt)}
    WHERE id = ${Math.max(0, Math.trunc(Number(id) || 0))};
  `);
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

test("resolveAnythingllmDbPath resolves official desktop paths and override", () => {
  assert.equal(
    resolveAnythingllmDbPath({ TOKENTRACKER_ANYTHINGLLM_DB: "  /custom/anythingllm.db  " }, "linux"),
    "/custom/anythingllm.db",
  );
  assert.equal(
    resolveAnythingllmDbPath({ XDG_CONFIG_HOME: "/config" }, "linux"),
    path.join("/config", "anythingllm-desktop", "storage", "anythingllm.db"),
  );
  assert.equal(
    resolveAnythingllmDbPath({ HOME: "/Users/test" }, "darwin"),
    path.join("/Users/test", "Library", "Application Support", "anythingllm-desktop", "storage", "anythingllm.db"),
  );
  assert.equal(
    resolveAnythingllmDbPath({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32"),
    path.join("C:\\Users\\test\\AppData\\Roaming", "anythingllm-desktop", "storage", "anythingllm.db"),
  );
});

test("parseAnythingllmTimestamp treats SQLite timestamps as UTC", () => {
  assert.equal(parseAnythingllmTimestamp("2026-07-14 08:09:10"), "2026-07-14T08:09:10.000Z");
  assert.equal(parseAnythingllmTimestamp("2026-07-14T08:09:10.25"), "2026-07-14T08:09:10.250Z");
  assert.equal(parseAnythingllmTimestamp(1783905543951), "2026-07-13T01:19:03.951Z");
  assert.equal(parseAnythingllmTimestamp("1783905543951"), "2026-07-13T01:19:03.951Z");
  assert.equal(parseAnythingllmTimestamp("not-a-date"), null);
});

test("AnythingLLM parser reads metrics only, aggregates incrementally, and stays idempotent", async () => {
  const { dir, dbPath } = createAnythingllmDb();
  try {
    insertChat(dbPath, {
      prompt: "PRIVATE PROMPT MUST NEVER LEAVE SQLITE",
      response: JSON.stringify({
        text: "PRIVATE RESPONSE MUST NEVER LEAVE SQLITE",
        sources: [{ text: "PRIVATE SOURCE" }],
        metrics: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 130,
          model: "deepseek-v4",
          provider: "DeepSeek",
        },
      }),
      createdAt: Date.parse("2026-07-14T14:05:00.000Z"),
    });
    insertChat(dbPath, {
      prompt: "another private prompt",
      response: "not-json",
      createdAt: "2026-07-14 14:10:00",
    });

    const projected = readAnythingllmUsageRows(dbPath);
    assert.equal(projected.length, 2);
    assert.deepEqual(Object.keys(projected[0]).sort(), [
      "completion_tokens",
      "createdAt",
      "id",
      "include",
      "lastUpdatedAt",
      "model",
      "prompt_tokens",
      "total_tokens",
    ]);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|another private/i);

    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const progressIndexes = [];
    const first = await parseAnythingllmIncremental({
      dbPath,
      cursors,
      queuePath,
      onProgress: (progress) => progressIndexes.push(progress.index),
    });
    assert.deepEqual(first, { recordsProcessed: 2, eventsAggregated: 1, bucketsQueued: 1 });
    assert.deepEqual(progressIndexes, [1, 2]);
    assert.equal(cursors.anythingllm.lastChatId, 2, "invalid rows still advance the append-only cursor");
    assert.deepEqual(cursors.anythingllm.pendingChatIds, []);

    let queueRows = readQueue(queuePath);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].source, "anythingllm");
    assert.equal(queueRows[0].model, "deepseek-v4");
    assert.equal(queueRows[0].input_tokens, 100);
    assert.equal(queueRows[0].output_tokens, 25);
    assert.equal(queueRows[0].reasoning_output_tokens, 5);
    assert.equal(queueRows[0].total_tokens, 130);
    assert.equal(queueRows[0].conversation_count, 1);

    const second = await parseAnythingllmIncremental({ dbPath, cursors, queuePath });
    assert.deepEqual(second, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });

    insertChat(dbPath, {
      prompt: "private follow-up",
      response: JSON.stringify({
        text: "private answer",
        metrics: {
          prompt_tokens: 50,
          completion_tokens: 10,
          total_tokens: 60,
          model: "deepseek-v4",
          provider: "DeepSeek",
        },
      }),
      createdAt: "2026-07-14 14:20:00",
    });

    const third = await parseAnythingllmIncremental({ dbPath, cursors, queuePath });
    assert.deepEqual(third, { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 });
    assert.equal(cursors.anythingllm.lastChatId, 3);

    queueRows = readQueue(queuePath);
    const latest = queueRows.at(-1);
    assert.equal(latest.total_tokens, 190, "latest bucket contains both AnythingLLM messages");
    assert.equal(latest.conversation_count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AnythingLLM parser retries an in-progress chat and counts its completed metrics once", async () => {
  const { dir, dbPath } = createAnythingllmDb();
  try {
    const nowMs = Date.parse("2026-07-14T16:10:00.000Z");
    insertChat(dbPath, {
      prompt: "private agent prompt",
      response: "{}",
      include: false,
      createdAt: Date.parse("2026-07-14T16:05:00.000Z"),
    });

    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const first = await parseAnythingllmIncremental({ dbPath, cursors, queuePath, nowMs });
    assert.deepEqual(first, { recordsProcessed: 1, eventsAggregated: 0, bucketsQueued: 0 });
    assert.equal(cursors.anythingllm.lastChatId, 1);
    assert.deepEqual(cursors.anythingllm.pendingChatIds, [1]);
    assert.deepEqual(readQueue(queuePath), []);

    updateChatResponse(
      dbPath,
      1,
      JSON.stringify({
        text: "private agent response",
        metrics: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          model: "agent-model",
        },
      }),
      Date.parse("2026-07-14T16:06:00.000Z"),
    );

    const second = await parseAnythingllmIncremental({ dbPath, cursors, queuePath, nowMs });
    assert.deepEqual(second, { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 });
    assert.deepEqual(cursors.anythingllm.pendingChatIds, []);
    const queueAfterCompletion = readQueue(queuePath);
    assert.equal(queueAfterCompletion.length, 1);
    assert.equal(queueAfterCompletion[0].total_tokens, 150);
    assert.equal(queueAfterCompletion[0].conversation_count, 1);

    const third = await parseAnythingllmIncremental({ dbPath, cursors, queuePath, nowMs });
    assert.deepEqual(third, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });
    assert.deepEqual(cursors.anythingllm.pendingChatIds, []);
    assert.deepEqual(readQueue(queuePath), queueAfterCompletion);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AnythingLLM parser does not retry completed invalid rows or stale aborted agents", async () => {
  const { dir, dbPath } = createAnythingllmDb();
  try {
    const nowMs = Date.parse("2026-07-14T16:10:00.000Z");
    insertChat(dbPath, {
      prompt: "completed row without metrics",
      response: "not-json",
      include: true,
      createdAt: nowMs - 60_000,
    });
    insertChat(dbPath, {
      prompt: "stale aborted agent",
      response: "{}",
      include: false,
      createdAt: nowMs - 25 * 60 * 60 * 1000,
    });

    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const first = await parseAnythingllmIncremental({ dbPath, cursors, queuePath, nowMs });
    assert.deepEqual(first, { recordsProcessed: 2, eventsAggregated: 0, bucketsQueued: 0 });
    assert.equal(cursors.anythingllm.lastChatId, 2);
    assert.deepEqual(cursors.anythingllm.pendingChatIds, []);

    const second = await parseAnythingllmIncremental({ dbPath, cursors, queuePath, nowMs });
    assert.deepEqual(second, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });
    assert.deepEqual(cursors.anythingllm.pendingChatIds, []);
    assert.deepEqual(readQueue(queuePath), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AnythingLLM parser treats a missing database as a no-op", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-empty-"));
  try {
    const cursors = {};
    const result = await parseAnythingllmIncremental({
      dbPath: path.join(dir, "missing.db"),
      cursors,
      queuePath: path.join(dir, "queue.jsonl"),
    });
    assert.deepEqual(result, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });
    assert.equal(cursors.anythingllm.lastChatId, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync and status commands expose the AnythingLLM Desktop integration", () => {
  const { dir, dbPath } = createAnythingllmDb();
  try {
    insertChat(dbPath, {
      prompt: "private command-path prompt",
      response: JSON.stringify({
        text: "private command-path response",
        metrics: {
          prompt_tokens: 40,
          completion_tokens: 8,
          total_tokens: 48,
          model: "deepseek-v4",
          provider: "DeepSeek",
        },
      }),
      createdAt: "2026-07-14 15:05:00",
    });

    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: path.join(dir, "AppData", "Roaming"),
      TOKENTRACKER_ANYTHINGLLM_DB: dbPath,
      TOKENTRACKER_NO_TELEMETRY: "1",
      TOKENTRACKER_WSL_MODE: "native-only",
    };

    const sync = cp.spawnSync(
      process.execPath,
      [TRACKER, "sync", "--auto", "--from-notify", "--source", "anythingllm"],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(sync.status, 0, `sync failed: ${sync.stderr || sync.stdout}`);

    const queuePath = path.join(dir, ".tokentracker", "tracker", "queue.jsonl");
    const rows = readQueue(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "anythingllm");
    assert.equal(rows[0].model, "deepseek-v4");
    assert.equal(rows[0].total_tokens, 48);

    const status = cp.spawnSync(process.execPath, [TRACKER, "status", "--json"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(status.status, 0, `status failed: ${status.stderr || status.stdout}`);
    const summary = JSON.parse(status.stdout);
    assert.deepEqual(summary.providers.anythingllm, {
      installed: true,
      detail: dbPath,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
