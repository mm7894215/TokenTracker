"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const { mockPlatform, mockMethod } = require("./helpers/mock");
const { cmdSync } = require("../src/commands/sync");
const {
  getCopilotSqliteFingerprint,
  normalizeCopilotSessionStoreUsage,
  parseCopilotAppDbIncremental,
  parseCopilotIncremental,
  parseCopilotSessionStoreIncremental,
  coalesceCopilotDbStatesByIdentity,
  resolveCopilotAppDbPaths,
  resolveCopilotSessionStorePaths,
} = require("../src/lib/rollout");

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(dbPath, sql) {
  cp.execFileSync("sqlite3", [dbPath, sql], { stdio: ["ignore", "ignore", "pipe"] });
}

function createStoreSchema(dbPath) {
  runSql(dbPath, `
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (6);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      token_details_json TEXT,
      created_at TEXT
    );
  `);
}

function makeStoreDb(rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-store-test-"));
  const copilotHome = path.join(dir, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  const dbPath = path.join(copilotHome, "session-store.db");
  createStoreSchema(dbPath);
  for (const row of rows) insertUsage(dbPath, row);
  return { dir, copilotHome, dbPath };
}

function makeAppDb(copilotHome, row) {
  const dbPath = path.join(copilotHome, "data.db");
  runSql(dbPath, `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_type TEXT,
      model TEXT,
      provider_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      total_cached_tokens INTEGER,
      total_reasoning_tokens INTEGER
    );
    INSERT INTO sessions (
      id, session_type, model, provider_id, created_at, updated_at,
      total_input_tokens, total_output_tokens, total_cached_tokens,
      total_reasoning_tokens
    ) VALUES (
      ${sqlValue(row.id)}, 'project', ${sqlValue(row.model)}, NULL,
      ${sqlValue(row.created_at)}, ${sqlValue(row.updated_at)},
      ${sqlValue(row.total_input_tokens)}, ${sqlValue(row.total_output_tokens)},
      ${sqlValue(row.total_cached_tokens)}, ${sqlValue(row.total_reasoning_tokens)}
    );
  `);
  return dbPath;
}

function updateAppUsage(dbPath, id, values) {
  const setSql = Object.entries(values)
    .map(([column, value]) => `${column}=${sqlValue(value)}`)
    .join(", ");
  runSql(dbPath, `UPDATE sessions SET ${setSql} WHERE id=${sqlValue(id)};`);
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(dbPath, future, future);
}

function insertUsage(dbPath, row) {
  const columns = [
    "id",
    "session_id",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "token_details_json",
    "created_at",
  ];
  const values = columns.map((column) => sqlValue(row[column]));
  runSql(
    dbPath,
    `INSERT INTO assistant_usage_events (${columns.join(", ")}) VALUES (${values.join(", ")});`,
  );
}

function tokenDetails({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  return JSON.stringify([
    { tokenType: "input", tokenCount: input, batchSize: 1_000_000, costPerBatch: 1 },
    { tokenType: "cache_read", tokenCount: cacheRead, batchSize: 1_000_000, costPerBatch: 1 },
    { tokenType: "cache_write", tokenCount: cacheWrite, batchSize: 1_000_000, costPerBatch: 1 },
    { tokenType: "output", tokenCount: output, batchSize: 1_000_000, costPerBatch: 1 },
  ]);
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function withSyncHome(home, fn) {
  const keys = [
    "HOME",
    "USERPROFILE",
    "TOKENTRACKER_DEVICE_TOKEN",
    "TOKENTRACKER_INSFORGE_BASE_URL",
    "COPILOT_HOME",
    "TOKENTRACKER_WSL_MODE",
    "COPILOT_OTEL_ENABLED",
    "COPILOT_OTEL_EXPORTER_TYPE",
    "COPILOT_OTEL_FILE_EXPORTER_PATH",
    "TOKENTRACKER_COPILOT_APP_DB",
    "TOKENTRACKER_COPILOT_SESSION_STORE_DB",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of keys.slice(2)) delete process.env[key];
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeCliSpan({
  sessionId = "session-cli",
  model = "gpt-cli",
  input = 100,
  output = 20,
  cacheRead = 0,
  cacheWrite = 0,
  seconds = 1780000000,
  traceId = "trace-cli",
  spanId = "span-cli",
} = {}) {
  return {
    type: "span",
    traceId,
    spanId,
    name: `chat ${model}`,
    startTime: [seconds - 1, 0],
    endTime: [seconds, 0],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.conversation.id": sessionId,
      "gen_ai.response.model": model,
      "gen_ai.usage.input_tokens": input,
      "gen_ai.usage.output_tokens": output,
      ...(cacheRead > 0
        ? { "gen_ai.usage.cache_read.input_tokens": cacheRead }
        : {}),
      ...(cacheWrite > 0
        ? { "gen_ai.usage.cache_write.input_tokens": cacheWrite }
        : {}),
    },
  };
}

function makeChatLogRecord({
  model = "gpt-chat",
  input = 80,
  output = 10,
  seconds = 1780000010,
} = {}) {
  return {
    hrTime: [seconds, 0],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.response.id": "response-chat",
      "gen_ai.response.model": model,
      "gen_ai.usage.input_tokens": input,
      "gen_ai.usage.output_tokens": output,
    },
  };
}

test("normalizeCopilotSessionStoreUsage uses token details to split cache writes", () => {
  const normalized = normalizeCopilotSessionStoreUsage({
    input_tokens: 125,
    output_tokens: 7,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    reasoning_tokens: 3,
    token_details_json: tokenDetails({
      input: 5,
      cacheRead: 20,
      cacheWrite: 100,
      output: 7,
    }),
  });
  assert.deepEqual(normalized, {
    input_tokens: 5,
    cached_input_tokens: 20,
    cache_creation_input_tokens: 100,
    output_tokens: 4,
    reasoning_output_tokens: 3,
    total_tokens: 132,
    precision: "exact",
  });
});

test("normalizeCopilotSessionStoreUsage falls back to top-level usage", () => {
  const normalized = normalizeCopilotSessionStoreUsage({
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 30,
    cache_write_tokens: 20,
    reasoning_tokens: 2,
    token_details_json: "{bad json",
  });
  assert.equal(normalized.input_tokens, 50);
  assert.equal(normalized.cached_input_tokens, 30);
  assert.equal(normalized.cache_creation_input_tokens, 20);
  assert.equal(normalized.output_tokens, 8);
  assert.equal(normalized.reasoning_output_tokens, 2);
  assert.equal(normalized.total_tokens, 110);
  assert.equal(normalized.precision, "fallback");
});

test("session store adopts existing rows, then emits only new App/CLI requests", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "existing-session",
      model: "gpt-5.6-luna",
      input_tokens: 50,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 5, cacheWrite: 45, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const adopted = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(adopted.active, true);
    assert.equal(adopted.adoptedThisRun, true);
    assert.equal(adopted.eventsAggregated, 0);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
    assert.deepEqual(readQueue(queuePath), []);

    insertUsage(dbPath, {
      id: 2,
      session_id: "existing-session",
      model: "gpt-5.6-luna",
      input_tokens: 125,
      output_tokens: 7,
      cache_read_tokens: 20,
      cache_write_tokens: 0,
      reasoning_tokens: 3,
      token_details_json: tokenDetails({
        input: 5,
        cacheRead: 20,
        cacheWrite: 100,
        output: 7,
      }),
      created_at: "2026-07-10T10:30:05Z",
    });
    const incremental = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(incremental.adoptedThisRun, false);
    assert.equal(incremental.eventsAggregated, 1);
    const rows = readQueue(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "gpt-5.6-luna");
    assert.equal(rows[0].input_tokens, 5);
    assert.equal(rows[0].cached_input_tokens, 20);
    assert.equal(rows[0].cache_creation_input_tokens, 100);
    assert.equal(rows[0].output_tokens, 4);
    assert.equal(rows[0].reasoning_output_tokens, 3);
    assert.equal(rows[0].total_tokens, 132);
    assert.equal(rows[0].conversation_count, 0);

    const second = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(readQueue(queuePath).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session store can backfill a fresh install with per-model precision", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "fresh-session",
      model: "claude-opus-4.8",
      input_tokens: 30,
      output_tokens: 4,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
      reasoning_tokens: 2,
      token_details_json: tokenDetails({
        input: 5,
        cacheRead: 10,
        cacheWrite: 15,
        output: 4,
      }),
      created_at: "2026-07-10T11:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const result = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    assert.equal(result.eventsAggregated, 1);
    const [row] = readQueue(queuePath);
    assert.equal(row.model, "claude-opus-4-8");
    assert.equal(row.conversation_count, 1);
    assert.equal(row.input_tokens, 5);
    assert.equal(row.cached_input_tokens, 10);
    assert.equal(row.cache_creation_input_tokens, 15);
    assert.equal(row.output_tokens, 2);
    assert.equal(row.reasoning_output_tokens, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session store reconciles a recreated database by event fingerprint", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 5,
      session_id: "old-db-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({ dbPath, cursors, queuePath });
    fs.rmSync(dbPath, { force: true });
    createStoreSchema(dbPath);
    insertUsage(dbPath, {
      id: 1,
      session_id: "old-db-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    });
    insertUsage(dbPath, {
      id: 2,
      session_id: "new-db-session",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T11:30:00Z",
    });
    const result = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(result.adoptedThisRun, true);
    assert.equal(result.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
    assert.equal(readQueue(queuePath).length, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 22);

    insertUsage(dbPath, {
      id: 3,
      session_id: "written-after-reset",
      model: "gpt-5.6-luna",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T12:31:00Z",
    });
    const next = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(next.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 3);
    assert.equal(readQueue(queuePath).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session store detects same-id reset even when the inode is reused", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "old-same-id-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({ dbPath, cursors, queuePath });

    fs.rmSync(dbPath, { force: true });
    createStoreSchema(dbPath);
    insertUsage(dbPath, {
      id: 1,
      session_id: "new-same-id-session",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:30:00Z",
    });
    insertUsage(dbPath, {
      id: 2,
      session_id: "new-higher-id-session",
      model: "gpt-5.6-terra",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T12:31:00Z",
    });

    // Linux may immediately reuse the deleted file's inode. Force that exact
    // state so reset detection must use the last immutable event signature.
    cursors.copilotStore.dbs[dbPath].dbIno = fs.statSync(dbPath).ino;
    const reset = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(reset.adoptedThisRun, true);
    assert.equal(reset.eventsAggregated, 2);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inode changes alone do not trigger reset reconciliation", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "vacuum-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    cursors.copilotStore.dbs[dbPath].dbIno += 1;
    insertUsage(dbPath, {
      id: 2,
      session_id: "vacuum-session",
      model: "gpt-5.6-luna",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T12:30:00Z",
    });

    const result = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(result.adoptedThisRun, false);
    assert.equal(result.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[dbPath].resetAt, null);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset reconciliation preserves identical event multiplicity", async () => {
  const duplicate = {
    session_id: "duplicate-fingerprint-session",
    model: "gpt-5.6-luna",
    input_tokens: 10,
    output_tokens: 1,
    token_details_json: tokenDetails({ input: 10, output: 1 }),
    created_at: "2026-07-10T12:00:00Z",
  };
  const { dir, dbPath } = makeStoreDb([
    { id: 1, ...duplicate },
    { id: 2, ...duplicate },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    fs.rmSync(dbPath, { force: true });
    createStoreSchema(dbPath);
    insertUsage(dbPath, { id: 1, ...duplicate });
    insertUsage(dbPath, { id: 2, ...duplicate });
    insertUsage(dbPath, { id: 3, ...duplicate });

    const reset = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(reset.eventsAggregated, 1);
    assert.equal(readQueue(queuePath).at(-1).total_tokens, 33);
    assert.equal(
      Object.values(cursors.copilotStore.dbs[dbPath].seenEventCounts)[0],
      3,
    );

    const repeat = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(repeat.eventsAggregated, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed timestamps remain degraded without replay after reset", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "malformed-old",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "not-a-time",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    assert.equal(cursors.copilotStore.dbs[dbPath].malformedEventCount, 1);

    fs.rmSync(dbPath, { force: true });
    createStoreSchema(dbPath);
    insertUsage(dbPath, {
      id: 1,
      session_id: "malformed-old",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "not-a-time",
    });
    insertUsage(dbPath, {
      id: 2,
      session_id: "malformed-new",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "still-not-a-time",
    });

    const reset = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(reset.eventsAggregated, 0);
    assert.equal(cursors.copilotStore.dbs[dbPath].malformedEventCount, 2);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
    assert.deepEqual(readQueue(queuePath), []);

    runSql(
      dbPath,
      "UPDATE assistant_usage_events SET created_at='2026-07-10T12:30:00Z' WHERE id=2;",
    );
    const repaired = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(repaired.eventsAggregated, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 22);
    assert.equal(cursors.copilotStore.dbs[dbPath].malformedEventCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("conversation dedup retains more than ten thousand session IDs", async () => {
  const { dir, dbPath } = makeStoreDb();
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    cursors.copilotStore.seenSessions = [
      "resumed-session",
      ...Array.from({ length: 10_000 }, (_, index) => `history-${index}`),
    ];
    insertUsage(dbPath, {
      id: 1,
      session_id: "resumed-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    });

    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(readQueue(queuePath)[0].conversation_count, 0);
    assert.equal(cursors.copilotStore.seenSessions.length, 10_001);
    assert.ok(cursors.copilotStore.seenSessions.includes("resumed-session"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor upgrade seeds fingerprints without skipping a concurrent new row", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "cursor-upgrade-old",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({ dbPath, cursors, queuePath });
    delete cursors.copilotStore.dbs[dbPath].seenEventCounts;
    insertUsage(dbPath, {
      id: 2,
      session_id: "cursor-upgrade-new",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:30:00Z",
    });

    const result = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 22);
    assert.equal(
      Object.values(cursors.copilotStore.dbs[dbPath].seenEventCounts).length,
      2,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy cursor reset baselines once, reports a gap, then resumes", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "legacy-cursor-old",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({ dbPath, cursors, queuePath });
    delete cursors.copilotStore.dbs[dbPath].seenEventCounts;
    fs.rmSync(dbPath, { force: true });
    createStoreSchema(dbPath);
    insertUsage(dbPath, {
      id: 1,
      session_id: "legacy-cursor-reset",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:30:00Z",
    });

    const reset = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(reset.eventsAggregated, 0);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
    assert.equal(cursors.copilotStore.dbs[dbPath].resetGapEventCount, 1);

    insertUsage(dbPath, {
      id: 2,
      session_id: "legacy-cursor-after-reset",
      model: "gpt-5.6-terra",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T13:00:00Z",
    });
    const next = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(next.eventsAggregated, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one store reset does not pause or block another active store", async () => {
  const first = makeStoreDb([
    {
      id: 1,
      session_id: "first-store-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  const second = makeStoreDb([
    {
      id: 1,
      session_id: "second-store-session",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-multi-store-"));
  try {
    const queuePath = path.join(queueDir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({
      dbPaths: [first.dbPath, second.dbPath],
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });

    fs.rmSync(first.dbPath, { force: true });
    createStoreSchema(first.dbPath);
    insertUsage(first.dbPath, {
      id: 1,
      session_id: "first-store-reset",
      model: "gpt-5.6-luna",
      input_tokens: 30,
      output_tokens: 3,
      token_details_json: tokenDetails({ input: 30, output: 3 }),
      created_at: "2026-07-10T12:30:00Z",
    });
    insertUsage(second.dbPath, {
      id: 2,
      session_id: "second-store-session",
      model: "gpt-5.6-terra",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T12:30:00Z",
    });

    const result = await parseCopilotSessionStoreIncremental({
      dbPaths: [first.dbPath, second.dbPath],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);
    assert.deepEqual(result.canonicalDbPaths, [first.dbPath, second.dbPath]);
    assert.equal(cursors.copilotStore.dbs[first.dbPath].lastId, 1);
    assert.equal(cursors.copilotStore.dbs[second.dbPath].lastId, 2);

    insertUsage(second.dbPath, {
      id: 3,
      session_id: "second-store-session",
      model: "gpt-5.6-terra",
      input_tokens: 7,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 7, output: 1 }),
      created_at: "2026-07-10T12:31:00Z",
    });
    const next = await parseCopilotSessionStoreIncremental({
      dbPaths: [first.dbPath, second.dbPath],
      cursors,
      queuePath,
    });
    assert.equal(next.eventsAggregated, 1);
    assert.deepEqual(next.canonicalDbPaths, [first.dbPath, second.dbPath]);
    assert.equal(cursors.copilotStore.dbs[second.dbPath].lastId, 3);

    insertUsage(second.dbPath, {
      id: 4,
      session_id: "second-store-session",
      model: "gpt-5.6-terra",
      input_tokens: 9,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 9, output: 1 }),
      created_at: "2026-07-10T12:32:00Z",
    });
    const final = await parseCopilotSessionStoreIncremental({
      dbPaths: [first.dbPath, second.dbPath],
      cursors,
      queuePath,
    });
    assert.equal(final.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[second.dbPath].lastId, 4);
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(second.dir, { recursive: true, force: true });
    fs.rmSync(queueDir, { recursive: true, force: true });
  }
});

test("session store does not activate canonical ownership when one discovered DB fails", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "healthy-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  const badDbPath = path.join(dir, ".copilot", "broken-session-store.db");
  fs.writeFileSync(badDbPath, "not sqlite", "utf8");
  try {
    const cursors = {};
    const result = await parseCopilotSessionStoreIncremental({
      dbPaths: [dbPath, badDbPath],
      cursors,
      queuePath: path.join(dir, "queue.jsonl"),
    });
    assert.equal(result.active, false);
    assert.equal(result.dbErrors, 1);
    assert.equal(result.eventsAggregated, 0);
    assert.notEqual(cursors.copilotStore.active, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first adoption is deferred when the store changes after legacy snapshot", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "stable-cutoff-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const expected = getCopilotSqliteFingerprint(dbPath);
    insertUsage(dbPath, {
      id: 2,
      session_id: "written-during-catchup",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:00:01Z",
    });
    const cursors = {};
    const result = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath: path.join(dir, "queue.jsonl"),
      expectedFingerprints: { [dbPath]: expected },
    });
    assert.equal(result.active, false);
    assert.equal(result.eventsAggregated, 0);
    assert.notEqual(cursors.copilotStore.active, true);
    assert.equal(cursors.copilotStore.dbs[dbPath].adoptedAt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("App -> CLI -> App switching emits each post-adoption request once", async () => {
  const sessionId = "switching-session";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 50,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 5, cacheWrite: 45, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 50,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};

    const legacyApp = await parseCopilotAppDbIncremental({
      dbPath: appDb,
      cursors,
      queuePath,
    });
    const adoption = await parseCopilotSessionStoreIncremental({
      dbPath: storeDb,
      cursors,
      queuePath,
    });
    assert.equal(legacyApp.eventsAggregated, 1);
    assert.equal(adoption.eventsAggregated, 0);

    insertUsage(storeDb, {
      id: 2,
      session_id: sessionId,
      model: "gpt-5.6-terra",
      input_tokens: 30,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
      created_at: "2026-07-10T10:30:00Z",
    });
    const cliContinuation = await parseCopilotSessionStoreIncremental({
      dbPath: storeDb,
      cursors,
      queuePath,
    });
    const unchangedApp = await parseCopilotAppDbIncremental({
      dbPath: appDb,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(cliContinuation.eventsAggregated, 1);
    assert.equal(unchangedApp.eventsAggregated, 0);

    insertUsage(storeDb, {
      id: 3,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 40,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 4, cacheWrite: 36, output: 4 }),
      created_at: "2026-07-10T11:00:00Z",
    });
    updateAppUsage(appDb, sessionId, {
      updated_at: "2026-07-10T11:00:00Z",
      total_input_tokens: 90,
      total_output_tokens: 6,
    });
    const appContinuation = await parseCopilotSessionStoreIncremental({
      dbPath: storeDb,
      cursors,
      queuePath,
    });
    const observedApp = await parseCopilotAppDbIncremental({
      dbPath: appDb,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(appContinuation.eventsAggregated, 1);
    assert.equal(observedApp.eventsAggregated, 0);

    const rows = readQueue(queuePath);
    assert.equal(rows.length, 3);
    assert.equal(
      rows.reduce((sum, row) => sum + row.total_tokens, 0),
      52 + 33 + 44,
    );
    assert.equal(
      rows.reduce((sum, row) => sum + row.conversation_count, 0),
      1,
    );
    const byModel = rows.reduce((map, row) => {
      map.set(row.model, (map.get(row.model) || 0) + row.total_tokens);
      return map;
    }, new Map());
    assert.equal(byModel.get("gpt-5.6-luna"), 52 + 44);
    assert.equal(byModel.get("gpt-5.6-terra"), 33);

    const finalStore = await parseCopilotSessionStoreIncremental({
      dbPath: storeDb,
      cursors,
      queuePath,
    });
    const finalApp = await parseCopilotAppDbIncremental({
      dbPath: appDb,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(finalStore.eventsAggregated, 0);
    assert.equal(finalApp.eventsAggregated, 0);
    assert.equal(readQueue(queuePath).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI -> App -> CLI switching keeps App DB from replaying the App segment", async () => {
  const sessionId = "imported-cli-session";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T09:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: null,
    created_at: "2026-07-10T09:00:00Z",
    updated_at: "2026-07-10T09:10:00Z",
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotAppDbIncremental({ dbPath: appDb, cursors, queuePath });
    await parseCopilotSessionStoreIncremental({ dbPath: storeDb, cursors, queuePath });
    assert.deepEqual(readQueue(queuePath), []);

    insertUsage(storeDb, {
      id: 2,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 30,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 1,
      token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
      created_at: "2026-07-10T09:30:00Z",
    });
    updateAppUsage(appDb, sessionId, {
      updated_at: "2026-07-10T09:30:00Z",
      total_input_tokens: 30,
      total_output_tokens: 3,
      total_reasoning_tokens: 1,
    });
    await parseCopilotSessionStoreIncremental({ dbPath: storeDb, cursors, queuePath });
    const observed = await parseCopilotAppDbIncremental({
      dbPath: appDb,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(observed.eventsAggregated, 0);

    insertUsage(storeDb, {
      id: 3,
      session_id: sessionId,
      model: "gpt-5.6-terra",
      input_tokens: 25,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 4, cacheWrite: 21, output: 4 }),
      created_at: "2026-07-10T10:00:00Z",
    });
    await parseCopilotSessionStoreIncremental({ dbPath: storeDb, cursors, queuePath });
    const rows = readQueue(queuePath);
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 33 + 29);
    assert.equal(rows.reduce((sum, row) => sum + row.conversation_count, 0), 0);
    assert.equal(cursors.copilotApp.dbs[appDb].sessionTotals[sessionId].input, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical store mode skips CLI OTEL spans but keeps Chat extension records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-owner-test-"));
  try {
    const otelPath = path.join(dir, "copilot.jsonl");
    fs.writeFileSync(
      otelPath,
      [makeCliSpan(), makeChatLogRecord()].map(JSON.stringify).join("\n") + "\n",
      "utf8",
    );
    const queuePath = path.join(dir, "queue.jsonl");
    const result = await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors: {},
      queuePath,
      skipCliSpans: true,
    });
    assert.equal(result.eventsAggregated, 1);
    const [row] = readQueue(queuePath);
    assert.equal(row.model, "gpt-chat");
    assert.equal(row.input_tokens, 80);
    assert.equal(row.output_tokens, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync canonical mode skips unmatchable CLI OTEL and keeps Chat records", async () => {
  const seconds = 1_780_000_000;
  const { dir, copilotHome, dbPath } = makeStoreDb();
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      await cmdSync(args);

      insertUsage(dbPath, {
        id: 1,
        session_id: "canonical-unmatchable-cli",
        model: "gpt-5.6-luna",
        input_tokens: 100,
        output_tokens: 20,
        token_details_json: tokenDetails({ input: 100, output: 20 }),
        created_at: new Date(seconds * 1000).toISOString(),
      });
      const cliSpan = makeCliSpan({
        sessionId: "canonical-unmatchable-cli",
        model: "gpt-5.6-luna",
        input: 100,
        output: 20,
        seconds,
      });
      delete cliSpan.attributes["gen_ai.conversation.id"];
      const otelPath = path.join(copilotHome, "canonical.jsonl");
      fs.writeFileSync(
        otelPath,
        [cliSpan, makeChatLogRecord({ seconds: seconds + 10 })]
          .map(JSON.stringify)
          .join("\n") + "\n",
        "utf8",
      );
      process.env.COPILOT_OTEL_ENABLED = "true";
      process.env.COPILOT_OTEL_EXPORTER_TYPE = "file";
      process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = otelPath;
      await cmdSync(args);

      const rows = readQueue(queuePath);
      assert.equal(rows.length, 2);
      assert.equal(
        rows.reduce((sum, row) => sum + row.total_tokens, 0),
        120 + 90,
      );
      assert.equal(
        rows.filter((row) => row.model === "gpt-5.6-luna").length,
        1,
      );
      assert.equal(
        rows.filter((row) => row.model === "gpt-chat").length,
        1,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI OTEL splits cache writes and normalizes dotted Claude model IDs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-cache-test-"));
  try {
    const otelPath = path.join(dir, "copilot.jsonl");
    fs.writeFileSync(
      otelPath,
      JSON.stringify(
        makeCliSpan({
          sessionId: "cache-write-cli",
          model: "claude-opus-4.8",
          input: 125,
          output: 7,
          cacheRead: 20,
          cacheWrite: 100,
        }),
      ) + "\n",
      "utf8",
    );
    const queuePath = path.join(dir, "queue.jsonl");
    await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors: {},
      queuePath,
    });
    const [row] = readQueue(queuePath);
    assert.equal(row.model, "claude-opus-4-8");
    assert.equal(row.input_tokens, 5);
    assert.equal(row.cached_input_tokens, 20);
    assert.equal(row.cache_creation_input_tokens, 100);
    assert.equal(row.output_tokens, 7);
    assert.equal(row.total_tokens, 132);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store usage matcher skips only overlapping CLI OTEL requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-otel-match-test-"));
  try {
    const otelPath = path.join(dir, "copilot.jsonl");
    fs.writeFileSync(
      otelPath,
      [
        makeCliSpan({
          sessionId: "matched-session",
          model: "gpt-5.6-luna",
          input: 100,
          output: 20,
          seconds: 1780000000,
          traceId: "trace-matched",
          spanId: "span-matched",
        }),
        makeCliSpan({
          sessionId: "legacy-session",
          model: "gpt-4o",
          input: 80,
          output: 10,
          seconds: 1780000010,
          traceId: "trace-legacy",
          spanId: "span-legacy",
        }),
        makeCliSpan({
          sessionId: "cache-write-session",
          model: "gpt-5.6-luna",
          input: 125,
          output: 7,
          cacheRead: 20,
          cacheWrite: 100,
          seconds: 1780000015,
          traceId: "trace-cache-write",
          spanId: "span-cache-write",
        }),
        makeChatLogRecord({ model: "gpt-chat", seconds: 1780000020 }),
      ].map(JSON.stringify).join("\n") + "\n",
      "utf8",
    );
    const queuePath = path.join(dir, "queue.jsonl");
    const result = await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors: {},
      queuePath,
      storeUsageEvents: [
        {
          sessionId: "matched-session",
          model: "gpt-5.6-luna",
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          tsMs: 1780000000030,
        },
        {
          sessionId: "cache-write-session",
          model: "gpt-5.6-luna",
          input: 5,
          output: 7,
          cacheRead: 20,
          cacheWrite: 100,
          reasoning: 0,
          tsMs: 1780000015030,
        },
      ],
    });
    assert.equal(result.eventsAggregated, 2);
    const rows = readQueue(queuePath);
    assert.deepEqual(
      rows.map((row) => row.model).sort(),
      ["gpt-4o", "gpt-chat"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed store row consumes an OTEL request counted on the previous sync", async () => {
  const { dir, dbPath } = makeStoreDb([]);
  try {
    const sessionId = "delayed-store-session";
    const seconds = 1780000000;
    const otelPath = path.join(dir, "copilot-delayed.jsonl");
    fs.writeFileSync(
      otelPath,
      JSON.stringify(
        makeCliSpan({
          sessionId,
          model: "gpt-5.6-luna",
          input: 100,
          output: 20,
          seconds,
        }),
      ) + "\n",
      "utf8",
    );
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const otel = await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors,
      queuePath,
    });
    assert.equal(otel.eventsAggregated, 1);
    assert.equal(cursors.copilot.recentUsageEvents.length, 1);

    insertUsage(dbPath, {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000 + 30).toISOString(),
    });
    const store = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
      otelUsageEvents: cursors.copilot.recentUsageEvents,
    });
    assert.equal(store.eventsAggregated, 0);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
    assert.equal(readQueue(queuePath).length, 1);
    assert.equal(cursors.copilot.recentUsageEvents[0].consumed, true);
    assert.equal(cursors.copilotStore.recentEvents.length, 0);

    insertUsage(dbPath, {
      id: 2,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000 + 30).toISOString(),
    });
    const distinctStoreRequest = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors,
      queuePath,
      otelUsageEvents: cursors.copilot.recentUsageEvents,
    });
    assert.equal(distinctStoreRequest.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
    assert.equal(readQueue(queuePath).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed OTEL and store claims are migrated, expired, and bounded", async () => {
  const { dir, dbPath } = makeStoreDb();
  try {
    const claims = [
      {
        sessionId: "expired-claim",
        model: "gpt-5.6-luna",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        tsMs: 1_780_000_000_000,
        firstSeenAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
      },
      ...Array.from({ length: 10_001 }, (_, index) => ({
        sessionId: `claim-${index}`,
        model: "gpt-5.6-luna",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        tsMs: 1_780_000_000_001 + index,
      })),
    ];
    const storeQueue = path.join(dir, "store-queue.jsonl");
    const transientOtelClaims = claims
      .slice(1)
      .map((claim) => ({ ...claim }));
    const storeCursors = {
      copilotStore: {
        active: true,
        recentEvents: claims.map((claim) => ({ ...claim })),
        dbs: {},
      },
    };
    await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors: storeCursors,
      queuePath: storeQueue,
      otelUsageEvents: transientOtelClaims,
    });
    assert.equal(storeCursors.copilotStore.recentEvents.length, 10_000);
    assert.equal(
      storeCursors.copilotStore.recentEvents.some(
        (claim) => claim.sessionId === "expired-claim",
      ),
      false,
    );
    assert.equal(storeCursors.copilotStore.recentEvents[0].sessionId, "claim-1");
    assert.ok(
      storeCursors.copilotStore.recentEvents.every(
        (claim) => Number.isFinite(claim.firstSeenAtMs),
      ),
    );
    assert.equal(transientOtelClaims.length, 10_001);

    const otelPath = path.join(dir, "chat.jsonl");
    fs.writeFileSync(
      otelPath,
      JSON.stringify(makeChatLogRecord()) + "\n",
      "utf8",
    );
    const otelCursors = {
      copilot: {
        version: 2,
        recentUsageEvents: claims.map((claim) => ({ ...claim })),
      },
    };
    const transientStoreClaims = claims
      .slice(1)
      .map((claim) => ({ ...claim }));
    await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors: otelCursors,
      queuePath: path.join(dir, "otel-queue.jsonl"),
      storeUsageEvents: transientStoreClaims,
    });
    assert.equal(otelCursors.copilot.recentUsageEvents.length, 10_000);
    assert.equal(
      otelCursors.copilot.recentUsageEvents[0].sessionId,
      "claim-1",
    );
    assert.ok(
      otelCursors.copilot.recentUsageEvents.every(
        (claim) => Number.isFinite(claim.firstSeenAtMs),
      ),
    );
    assert.equal(transientStoreClaims.length, 10_001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-run matching sees claims beyond the persisted cap", async () => {
  const seconds = 1_780_000_000;
  const target = {
    sessionId: "oldest-transient-claim",
    model: "gpt-5.6-luna",
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tsMs: seconds * 1000,
    firstSeenAtMs: Date.now(),
  };
  const fillers = Array.from({ length: 10_000 }, (_, index) => ({
    sessionId: `transient-filler-${index}`,
    model: "gpt-5.6-luna",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tsMs: seconds * 1000 + index + 1,
    firstSeenAtMs: Date.now(),
  }));
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: target.sessionId,
      model: target.model,
      input_tokens: 100,
      output_tokens: 20,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(target.tsMs).toISOString(),
    },
  ]);
  try {
    const otelClaims = [
      { ...target },
      ...fillers.map((claim) => ({ ...claim })),
    ];
    const storeResult = await parseCopilotSessionStoreIncremental({
      dbPath,
      cursors: {},
      queuePath: path.join(dir, "store-match-queue.jsonl"),
      backfillOnFirstRun: true,
      otelUsageEvents: otelClaims,
    });
    assert.equal(storeResult.eventsAggregated, 0);

    const otelPath = path.join(dir, "transient-match.jsonl");
    fs.writeFileSync(
      otelPath,
      JSON.stringify(
        makeCliSpan({
          sessionId: target.sessionId,
          model: target.model,
          input: 100,
          output: 20,
          seconds,
        }),
      ) + "\n",
      "utf8",
    );
    const storeClaims = [
      { ...target },
      ...fillers.map((claim) => ({ ...claim })),
    ];
    const otelResult = await parseCopilotIncremental({
      otelPaths: [otelPath],
      cursors: {},
      queuePath: path.join(dir, "otel-match-queue.jsonl"),
      storeUsageEvents: storeClaims,
    });
    assert.equal(otelResult.eventsAggregated, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCopilotSessionStorePaths includes custom and default homes", () => {
  const paths = resolveCopilotSessionStorePaths({
    HOME: "/tmp/copilot-store-home",
    COPILOT_HOME: "/tmp/copilot-store-custom",
  });
  assert.ok(paths.includes(path.join("/tmp/copilot-store-home", ".copilot", "session-store.db")));
  assert.ok(paths.includes(path.join("/tmp/copilot-store-custom", "session-store.db")));
});

test("physical aliases of one store are scanned only once", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "aliased-store-session",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  const symlinkPath = path.join(dir, "store-symlink.db");
  const hardlinkPath = path.join(dir, "store-hardlink.db");
  fs.linkSync(dbPath, hardlinkPath);
  const aliases = [dbPath, hardlinkPath];
  if (process.platform !== "win32") {
    fs.symlinkSync(dbPath, symlinkPath);
    aliases.push(symlinkPath);
  }
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const result = await parseCopilotSessionStoreIncremental({
      dbPaths: aliases,
      cursors,
      queuePath,
      backfillOnFirstRun: true,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 11);
    assert.equal(Object.keys(cursors.copilotStore.dbs).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("alias dedup prefers the path that already owns the cursor", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "alias-cursor-old",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T12:00:00Z",
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotSessionStoreIncremental({ dbPath, cursors, queuePath });
    const aliasPath = path.join(dir, "preferred-first-hardlink.db");
    fs.linkSync(dbPath, aliasPath);
    insertUsage(dbPath, {
      id: 2,
      session_id: "alias-cursor-new",
      model: "gpt-5.6-terra",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T12:30:00Z",
    });

    const result = await parseCopilotSessionStoreIncremental({
      dbPaths: [aliasPath, dbPath],
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(readQueue(queuePath)[0].total_tokens, 22);
    assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);
    assert.equal(cursors.copilotStore.dbs[aliasPath], undefined);

    fs.rmSync(dbPath, { force: true });
    insertUsage(aliasPath, {
      id: 3,
      session_id: "alias-cursor-after-removal",
      model: "gpt-5.6-terra",
      input_tokens: 5,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 5, output: 1 }),
      created_at: "2026-07-10T13:00:00Z",
    });
    const afterRemoval = await parseCopilotSessionStoreIncremental({
      dbPaths: [dbPath, aliasPath],
      cursors,
      queuePath,
    });
    assert.equal(afterRemoval.eventsAggregated, 1);
    assert.equal(cursors.copilotStore.dbs[aliasPath].lastId, 3);
    assert.equal(cursors.copilotStore.dbs[dbPath], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("alias state migration requires matching device and inode", (t) => {
  const oldPath = "/old-volume/session-store.db";
  const newPath = "/new-volume/session-store.db";
  mockMethod(t, fs, "statSync", (candidate) => {
    if (candidate === newPath) return { dev: 2, ino: 7 };
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  });
  const dbStates = {
    [oldPath]: {
      lastDbFingerprint: { db: { dev: 1, ino: 7 } },
      lastId: 10,
    },
  };
  const migrated = coalesceCopilotDbStatesByIdentity(
    dbStates,
    [newPath],
    (primary, alias) => ({ ...primary, ...alias }),
  );
  assert.equal(migrated.size, 0);
  assert.ok(dbStates[oldPath]);
  assert.equal(dbStates[newPath], undefined);
});

test("resolveCopilotSessionStorePaths keeps Windows native discovery enabled", (t) => {
  mockPlatform(t, "win32");
  mockMethod(t, cp, "execFileSync", () => {
    throw new Error("no WSL distros");
  });
  const paths = resolveCopilotSessionStorePaths({
    HOME: "C:\\Users\\dev",
    TOKENTRACKER_WSL_MODE: "native-only",
  });
  assert.equal(paths.length, 1);
  assert.match(paths[0], /\.copilot[\\/]session-store\.db$/);
});

test("Windows native Copilot paths prefer USERPROFILE over shell HOME", (t) => {
  mockPlatform(t, "win32");
  mockMethod(t, cp, "execFileSync", () => {
    throw new Error("no WSL distros");
  });
  const env = {
    HOME: "D:\\GitBash\\home",
    USERPROFILE: "C:\\Users\\dev",
    TOKENTRACKER_WSL_MODE: "native-only",
  };
  const storePaths = resolveCopilotSessionStorePaths(env);
  const appPaths = resolveCopilotAppDbPaths(env);
  assert.match(storePaths[0], /C:\\Users\\dev/);
  assert.match(appPaths[0], /C:\\Users\\dev/);
  assert.doesNotMatch(storePaths[0], /GitBash/);
  assert.doesNotMatch(appPaths[0], /GitBash/);
});

test("automatic Copilot discovery stays native when WSL is preferred", (t) => {
  mockPlatform(t, "win32");
  const env = {
    HOME: "D:\\GitBash\\home",
    USERPROFILE: "C:\\Users\\dev",
    TOKENTRACKER_WSL_MODE: "wsl-first",
  };
  const storePaths = resolveCopilotSessionStorePaths(env);
  const appPaths = resolveCopilotAppDbPaths(env);
  assert.equal(storePaths.length, 1);
  assert.equal(appPaths.length, 1);
  assert.match(storePaths[0], /C:\\Users\\dev/);
  assert.match(appPaths[0], /C:\\Users\\dev/);
});

test("cmdSync scans physical App DB aliases only once before adoption", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-app-alias-"));
  const copilotHome = path.join(dir, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  const appDb = makeAppDb(copilotHome, {
    id: "app-alias-session",
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  const aliasPath = path.join(dir, "app-data-hardlink.db");
  fs.linkSync(appDb, aliasPath);
  try {
    await withSyncHome(dir, async () => {
      process.env.TOKENTRACKER_COPILOT_APP_DB = aliasPath;
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].total_tokens, 22);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(Object.keys(cursors.copilotApp.dbs).length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync coalesces App DB aliases already present in legacy cursors", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-app-legacy-alias-"),
  );
  const copilotHome = path.join(dir, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  const appDb = makeAppDb(copilotHome, {
    id: "legacy-alias-session",
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:30:00Z",
    total_input_tokens: 30,
    total_output_tokens: 3,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  const aliasPath = path.join(dir, "legacy-app-data-hardlink.db");
  fs.linkSync(appDb, aliasPath);
  try {
    await withSyncHome(dir, async () => {
      process.env.TOKENTRACKER_COPILOT_APP_DB = aliasPath;
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      const baseline = {
        sessionTotals: {
          "legacy-alias-session": {
            input: 20,
            output: 2,
            cached: 0,
            reasoning: 0,
            model: "gpt-5.6-luna",
            updatedAt: "2026-07-10T10:00:00Z",
          },
        },
      };
      fs.writeFileSync(
        path.join(trackerDir, "cursors.json"),
        JSON.stringify({
          copilotApp: {
            dbs: {
              [appDb]: structuredClone(baseline),
              [aliasPath]: structuredClone(baseline),
            },
          },
        }),
        "utf8",
      );

      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const queuePath = path.join(trackerDir, "queue.jsonl");
      let rows = readQueue(queuePath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].total_tokens, 11);
      let cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      const [selectedPath] = Object.keys(cursors.copilotApp.dbs);
      assert.ok(selectedPath === appDb || selectedPath === aliasPath);
      assert.equal(Object.keys(cursors.copilotApp.dbs).length, 1);

      const remainingPath = selectedPath === appDb ? aliasPath : appDb;
      fs.rmSync(selectedPath, { force: true });
      updateAppUsage(remainingPath, "legacy-alias-session", {
        updated_at: "2026-07-10T11:00:00Z",
        total_input_tokens: 40,
        total_output_tokens: 4,
      });
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      rows = readQueue(queuePath);
      assert.equal(rows.length, 2);
      assert.equal(
        rows.reduce((sum, row) => sum + row.total_tokens, 0),
        22,
      );
      cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.ok(cursors.copilotApp.dbs[remainingPath]);
      assert.equal(Object.keys(cursors.copilotApp.dbs).length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync catches up App once, adopts store, then writes only store deltas", async () => {
  const sessionId = "sync-switching-session";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 50,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      token_details_json: tokenDetails({ input: 5, cacheWrite: 45, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
    {
      id: 2,
      session_id: "cli-only-before-adoption",
      model: "gpt-5.6-terra",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 1, cacheWrite: 9, output: 1 }),
      created_at: "2026-07-10T09:30:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 50,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      await cmdSync(args);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      const firstRows = readQueue(queuePath).filter((row) => row.source === "copilot");
      assert.equal(firstRows.length, 2);
      assert.equal(firstRows.reduce((sum, row) => sum + row.total_tokens, 0), 52 + 11);
      let cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.active, true);
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 2);

      insertUsage(storeDb, {
        id: 3,
        session_id: sessionId,
        model: "gpt-5.6-terra",
        input_tokens: 30,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      updateAppUsage(appDb, sessionId, {
        updated_at: "2026-07-10T10:30:00Z",
        total_input_tokens: 80,
        total_output_tokens: 5,
      });
      await cmdSync(args);
      const secondRows = readQueue(queuePath).filter((row) => row.source === "copilot");
      assert.equal(secondRows.length, 3);
      assert.equal(
        secondRows.reduce((sum, row) => sum + row.total_tokens, 0),
        52 + 11 + 33,
      );
      assert.equal(secondRows.filter((row) => row.model === "gpt-5.6-terra").length, 2);

      const beforeThird = fs.readFileSync(queuePath, "utf8");
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeThird);
      cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 3);
      assert.equal(
        cursors.copilotApp.dbs[appDb].sessionTotals[sessionId].input,
        80,
      );

      insertUsage(storeDb, {
        id: 4,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 20,
        output_tokens: 2,
        token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
        created_at: "2026-07-10T11:00:00Z",
      });
      await cmdSync(["--auto", "--from-retry", "--source=codex"]);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeThird);
      cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 3);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync does not adopt store when the legacy App catch-up fails", async () => {
  const { dir, copilotHome } = makeStoreDb([
    {
      id: 1,
      session_id: "pending-adoption",
      model: "gpt-5.6-luna",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  fs.writeFileSync(path.join(copilotHome, "data.db"), "not sqlite", "utf8");
  try {
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(dir, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );
      assert.notEqual(cursors.copilotStore?.active, true);
      assert.equal(cursors.copilotStore, undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync backfills store history when no legacy App or OTEL source exists", async () => {
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: "cli-only-fresh-install",
      model: "gpt-5.6-luna",
      input_tokens: 25,
      output_tokens: 3,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 23, output: 3 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  try {
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].input_tokens, 2);
      assert.equal(rows[0].cache_creation_input_tokens, 23);
      assert.equal(rows[0].output_tokens, 3);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(cursors.copilotStore.active, true);
      assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a current Chat-only OTEL file does not suppress CLI store backfill", async () => {
  const { dir } = makeStoreDb([
    {
      id: 1,
      session_id: "cli-history-with-chat-otel",
      model: "gpt-5.6-luna",
      input_tokens: 25,
      output_tokens: 3,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 23, output: 3 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  try {
    const otelDir = path.join(dir, ".copilot", "otel");
    fs.mkdirSync(otelDir, { recursive: true });
    fs.writeFileSync(
      path.join(otelDir, "chat.jsonl"),
      JSON.stringify(makeChatLogRecord({ model: "gpt-chat", seconds: 1780000000 })) + "\n",
      "utf8",
    );
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const rows = readQueue(
        path.join(dir, ".tokentracker", "tracker", "queue.jsonl"),
      );
      assert.deepEqual(
        rows.map((row) => row.model).sort(),
        ["gpt-5.6-luna", "gpt-chat"],
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first adoption deduplicates a current CLI OTEL file against store history", async () => {
  const seconds = 1780000000;
  const sessionId = "first-adoption-otel-match";
  const { dir, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000 + 30).toISOString(),
    },
  ]);
  try {
    const otelDir = path.join(dir, ".copilot", "otel");
    fs.mkdirSync(otelDir, { recursive: true });
    fs.writeFileSync(
      path.join(otelDir, "cli.jsonl"),
      JSON.stringify(
        makeCliSpan({
          sessionId,
          model: "gpt-5.6-luna",
          input: 100,
          output: 20,
          seconds,
        }),
      ) + "\n",
      "utf8",
    );
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].total_tokens, 120);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
      assert.equal(cursors.copilot.recentUsageEvents.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first adoption does not replay store rows for unmatchable CLI OTEL", async () => {
  const seconds = 1_780_000_000;
  const sessionId = "unmatchable-cli-otel";
  const { dir, copilotHome } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000).toISOString(),
    },
  ]);
  try {
    const span = makeCliSpan({
      sessionId,
      model: "gpt-5.6-luna",
      input: 100,
      output: 20,
      seconds,
    });
    delete span.attributes["gen_ai.conversation.id"];
    const otelPath = path.join(copilotHome, "unmatchable-cli.jsonl");
    fs.writeFileSync(otelPath, JSON.stringify(span) + "\n", "utf8");
    await withSyncHome(dir, async () => {
      process.env.COPILOT_OTEL_ENABLED = "true";
      process.env.COPILOT_OTEL_EXPORTER_TYPE = "file";
      process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = otelPath;
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].total_tokens, 120);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(cursors.copilot.usageClaimsComplete, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("App-owned adoption still consumes the matching CLI OTEL fingerprint", async () => {
  const seconds = 1780000000;
  const sessionId = "app-owned-otel-match";
  const { dir, copilotHome, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000 + 30).toISOString(),
    },
  ]);
  makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: new Date(seconds * 1000).toISOString(),
    updated_at: new Date(seconds * 1000).toISOString(),
    total_input_tokens: 40,
    total_output_tokens: 10,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    const otelDir = path.join(copilotHome, "otel");
    fs.mkdirSync(otelDir, { recursive: true });
    fs.writeFileSync(
      path.join(otelDir, "cli.jsonl"),
      JSON.stringify(
        makeCliSpan({
          sessionId,
          model: "gpt-5.6-luna",
          input: 100,
          output: 20,
          seconds,
        }),
      ) + "\n",
      "utf8",
    );
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.at(-1).total_tokens, 170);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
      assert.equal(cursors.copilot.recentUsageEvents.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first adoption preserves mixed-session CLI history as a legacy residual", async () => {
  const sessionId = "mixed-pre-adoption-session";
  const { dir, copilotHome, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
    {
      id: 2,
      session_id: sessionId,
      model: "gpt-5.6-terra",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T10:30:00Z",
    },
  ]);
  makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const queuePath = path.join(
        dir,
        ".tokentracker",
        "tracker",
        "queue.jsonl",
      );
      await cmdSync(args);
      const rows = readQueue(queuePath);
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 33);
      const residual = rows.find(
        (row) => row.model === "github-copilot-legacy",
      );
      assert.ok(residual);
      assert.equal(residual.input_tokens, 11);
      assert.equal(residual.total_tokens, 11);
      assert.equal(residual.conversation_count, 0);
      const cursors = JSON.parse(
        fs.readFileSync(
          path.join(dir, ".tokentracker", "tracker", "cursors.json"),
          "utf8",
        ),
      );
      assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 2);

      const beforeRepeat = fs.readFileSync(queuePath, "utf8");
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeRepeat);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Chat-only OTEL history does not block a mixed-session legacy residual", async () => {
  const sessionId = "mixed-with-chat-history";
  const { dir, copilotHome } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
    {
      id: 2,
      session_id: sessionId,
      model: "gpt-5.6-terra",
      input_tokens: 10,
      output_tokens: 1,
      token_details_json: tokenDetails({ input: 10, output: 1 }),
      created_at: "2026-07-10T10:30:00Z",
    },
  ]);
  makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      fs.mkdirSync(trackerDir, { recursive: true });
      const otelPath = path.join(copilotHome, "chat-history.jsonl");
      fs.writeFileSync(
        otelPath,
        JSON.stringify(makeChatLogRecord()) + "\n",
        "utf8",
      );
      const cursors = {};
      await parseCopilotIncremental({
        otelPaths: [otelPath],
        cursors,
        queuePath,
      });
      delete cursors.copilot.usageClaimsComplete;
      fs.writeFileSync(cursorsPath, JSON.stringify(cursors), "utf8");

      process.env.COPILOT_OTEL_ENABLED = "true";
      process.env.COPILOT_OTEL_EXPORTER_TYPE = "file";
      process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = otelPath;
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const residual = readQueue(queuePath).find(
        (row) => row.model === "github-copilot-legacy",
      );
      assert.ok(residual);
      assert.equal(residual.total_tokens, 11);
      const updatedCursors = JSON.parse(
        fs.readFileSync(cursorsPath, "utf8"),
      );
      assert.equal(updatedCursors.copilot.usageClaimsComplete, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy CLI OTEL history still prevents an unsafe store replay", async () => {
  const seconds = 1_780_000_000;
  const sessionId = "legacy-cli-otel-history";
  const { dir, copilotHome } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 100,
      output_tokens: 20,
      token_details_json: tokenDetails({ input: 100, output: 20 }),
      created_at: new Date(seconds * 1000).toISOString(),
    },
  ]);
  try {
    await withSyncHome(dir, async () => {
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      fs.mkdirSync(trackerDir, { recursive: true });
      const otelPath = path.join(copilotHome, "legacy-cli.jsonl");
      fs.writeFileSync(
        otelPath,
        JSON.stringify(
          makeCliSpan({
            sessionId,
            model: "gpt-5.6-luna",
            input: 100,
            output: 20,
            seconds,
          }),
        ) + "\n",
        "utf8",
      );
      const cursors = {};
      await parseCopilotIncremental({
        otelPaths: [otelPath],
        cursors,
        queuePath,
      });
      delete cursors.copilot.usageClaimsComplete;
      delete cursors.copilot.recentUsageEvents;
      fs.writeFileSync(cursorsPath, JSON.stringify(cursors), "utf8");
      const before = fs.readFileSync(queuePath, "utf8");

      process.env.COPILOT_OTEL_ENABLED = "true";
      process.env.COPILOT_OTEL_EXPORTER_TYPE = "file";
      process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = otelPath;
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      assert.equal(fs.readFileSync(queuePath, "utf8"), before);
      const updatedCursors = JSON.parse(
        fs.readFileSync(cursorsPath, "utf8"),
      );
      assert.equal(updatedCursors.copilot.legacyCliHistory, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync backfills an imported CLI session whose App baseline is still zero", async () => {
  const sessionId = "imported-zero-app-session";
  const { dir, copilotHome, dbPath } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 25,
      output_tokens: 3,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 23, output: 3 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  makeAppDb(copilotHome, {
    id: sessionId,
    model: null,
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:05:00Z",
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      await cmdSync(["--auto", "--from-retry", "--source=copilot"]);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const rows = readQueue(path.join(trackerDir, "queue.jsonl"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].total_tokens, 28);
      const cursors = JSON.parse(
        fs.readFileSync(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(cursors.copilotStore.dbs[dbPath].lastId, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit store override owns App usage outside the App DB directory", async () => {
  const sessionId = "explicit-store-app-session";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-explicit-home-"));
  const customStoreDir = path.join(home, "custom-copilot");
  const customStorePath = path.join(customStoreDir, "session-store.db");
  fs.mkdirSync(customStoreDir, { recursive: true });
  createStoreSchema(customStorePath);
  insertUsage(customStorePath, {
    id: 1,
    session_id: sessionId,
    model: "gpt-5.6-luna",
    input_tokens: 20,
    output_tokens: 2,
    token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
    created_at: "2026-07-10T10:00:00Z",
  });
  const appHome = path.join(home, ".copilot");
  fs.mkdirSync(appHome, { recursive: true });
  const appDb = makeAppDb(appHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(home, async () => {
      process.env.TOKENTRACKER_COPILOT_SESSION_STORE_DB =
        "~/custom-copilot/session-store.db";
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
      await cmdSync(args);

      insertUsage(customStorePath, {
        id: 2,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 10,
        output_tokens: 1,
        token_details_json: tokenDetails({ input: 1, cacheWrite: 9, output: 1 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      updateAppUsage(appDb, sessionId, {
        updated_at: "2026-07-10T10:30:00Z",
        total_input_tokens: 30,
        total_output_tokens: 3,
      });
      await cmdSync(args);
      const rows = readQueue(queuePath);
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 22 + 11);
      assert.equal(rows.length, 2);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cmdSync keeps App observe-only while an adopted store is unavailable", async () => {
  const sessionId = "temporarily-missing-store";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      await cmdSync(args);
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      const beforeQueue = fs.readFileSync(queuePath, "utf8");
      const beforeCursor = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(beforeCursor.copilotStore.active, true);

      fs.rmSync(storeDb, { force: true });
      const otelDir = path.join(copilotHome, "otel");
      fs.mkdirSync(otelDir, { recursive: true });
      fs.writeFileSync(
        path.join(otelDir, "delayed-cli.jsonl"),
        JSON.stringify(
          makeCliSpan({
            sessionId,
            model: "gpt-5.6-luna",
            input: 20,
            output: 2,
            cacheWrite: 18,
            seconds: Date.parse("2026-07-10T10:00:00Z") / 1000,
          }),
        ) + "\n",
        "utf8",
      );
      updateAppUsage(appDb, sessionId, {
        updated_at: "2026-07-10T10:30:00Z",
        total_input_tokens: 50,
        total_output_tokens: 5,
      });
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeQueue);
      let cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(
        cursors.copilotApp.dbs[appDb].sessionTotals[sessionId].input,
        50,
      );

      createStoreSchema(storeDb);
      insertUsage(storeDb, {
        id: 1,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 20,
        output_tokens: 2,
        token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
        created_at: "2026-07-10T10:00:00Z",
      });
      insertUsage(storeDb, {
        id: 2,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 30,
        output_tokens: 3,
        token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      await cmdSync(args);
      const recoveredRows = readQueue(queuePath);
      assert.equal(
        recoveredRows.reduce((sum, row) => sum + row.total_tokens, 0),
        22 + 33,
      );
      cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 2);
      assert.equal(cursors.copilotStore.active, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a newly discovered App DB stays observe-only after global adoption", async () => {
  const primary = makeStoreDb([
    {
      id: 1,
      session_id: "primary-store-session",
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 20, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  makeAppDb(primary.copilotHome, {
    id: "primary-store-session",
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  const secondaryDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-secondary-app-"),
  );
  const secondaryHome = path.join(secondaryDir, ".copilot");
  fs.mkdirSync(secondaryHome, { recursive: true });
  const secondaryApp = makeAppDb(secondaryHome, {
    id: "secondary-app-session",
    model: "gpt-5.6-terra",
    created_at: "2026-07-10T10:30:00Z",
    updated_at: "2026-07-10T10:30:00Z",
    total_input_tokens: 30,
    total_output_tokens: 3,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(primary.dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const queuePath = path.join(
        primary.dir,
        ".tokentracker",
        "tracker",
        "queue.jsonl",
      );
      await cmdSync(args);
      const before = fs.readFileSync(queuePath, "utf8");

      process.env.COPILOT_HOME = secondaryHome;
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), before);
      const cursors = JSON.parse(
        fs.readFileSync(
          path.join(
            primary.dir,
            ".tokentracker",
            "tracker",
            "cursors.json",
          ),
          "utf8",
        ),
      );
      assert.equal(
        cursors.copilotApp.dbs[secondaryApp].sessionTotals[
          "secondary-app-session"
        ].input,
        30,
      );
    });
  } finally {
    fs.rmSync(primary.dir, { recursive: true, force: true });
    fs.rmSync(secondaryDir, { recursive: true, force: true });
  }
});

test("cmdSync prunes a permanently missing App DB cursor once store is active", async () => {
  const sessionId = "removed-app-db-session";
  const { dir, copilotHome } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const cursorsPath = path.join(
        dir,
        ".tokentracker",
        "tracker",
        "cursors.json",
      );
      await cmdSync(args);
      let cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.ok(cursors.copilotApp.dbs[appDb]);
      assert.equal(cursors.copilotStore.active, true);

      fs.rmSync(appDb, { force: true });
      await cmdSync(args);
      cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotApp.dbs[appDb], undefined);
      assert.equal(cursors.copilotStore.active, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync retains App cursor when App and store are both temporarily missing", async () => {
  const sessionId = "temporarily-unmounted-copilot-home";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const cursorsPath = path.join(
        dir,
        ".tokentracker",
        "tracker",
        "cursors.json",
      );
      await cmdSync(args);
      fs.rmSync(appDb, { force: true });
      fs.rmSync(storeDb, { force: true });
      await cmdSync(args);
      const cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.ok(cursors.copilotApp.dbs[appDb]);
      assert.equal(
        cursors.copilotApp.dbs[appDb].sessionTotals[sessionId].input,
        20,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync retains App cursor while its store exists but is unreadable", async () => {
  const sessionId = "unreadable-copilot-store";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const cursorsPath = path.join(
        dir,
        ".tokentracker",
        "tracker",
        "cursors.json",
      );
      await cmdSync(args);
      fs.rmSync(appDb, { force: true });
      fs.rmSync(storeDb, { force: true });
      fs.writeFileSync(storeDb, "not sqlite", "utf8");
      await cmdSync(args);
      const cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.ok(cursors.copilotApp.dbs[appDb]);
      assert.equal(
        cursors.copilotApp.dbs[appDb].sessionTotals[sessionId].input,
        20,
      );
      assert.match(cursors.copilotStore.dbs[storeDb].lastError, /sqlite/i);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdSync reconciles new requests when an adopted store is recreated", async () => {
  const sessionId = "recreated-store-session";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      await cmdSync(args);
      const queuePath = path.join(dir, ".tokentracker", "tracker", "queue.jsonl");

      fs.rmSync(storeDb, { force: true });
      createStoreSchema(storeDb);
      insertUsage(storeDb, {
        id: 1,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 30,
        output_tokens: 3,
        token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      updateAppUsage(appDb, sessionId, {
        updated_at: "2026-07-10T10:30:00Z",
        total_input_tokens: 50,
        total_output_tokens: 5,
      });
      await cmdSync(args);
      let rows = readQueue(queuePath);
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 22 + 33);
      let cursors = JSON.parse(
        fs.readFileSync(
          path.join(dir, ".tokentracker", "tracker", "cursors.json"),
          "utf8",
        ),
      );

      insertUsage(storeDb, {
        id: 2,
        session_id: sessionId,
        model: "gpt-5.6-terra",
        input_tokens: 10,
        output_tokens: 1,
        token_details_json: tokenDetails({ input: 1, cacheWrite: 9, output: 1 }),
        created_at: "2026-07-10T11:00:00Z",
      });
      updateAppUsage(appDb, sessionId, {
        updated_at: "2026-07-10T11:00:00Z",
        total_input_tokens: 60,
        total_output_tokens: 6,
      });
      await cmdSync(args);
      rows = readQueue(queuePath);
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 22 + 33 + 11);
      assert.equal(rows.filter((row) => row.model === "gpt-5.6-terra").length, 1);
      cursors = JSON.parse(
        fs.readFileSync(
          path.join(dir, ".tokentracker", "tracker", "cursors.json"),
          "utf8",
        ),
      );

      const beforeRepeat = fs.readFileSync(queuePath, "utf8");
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeRepeat);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt App DB does not block canonical reset reconciliation", async () => {
  const sessionId = "reset-catchup-retry";
  const { dir, copilotHome, dbPath: storeDb } = makeStoreDb([
    {
      id: 1,
      session_id: sessionId,
      model: "gpt-5.6-luna",
      input_tokens: 20,
      output_tokens: 2,
      token_details_json: tokenDetails({ input: 2, cacheWrite: 18, output: 2 }),
      created_at: "2026-07-10T10:00:00Z",
    },
  ]);
  const appDb = makeAppDb(copilotHome, {
    id: sessionId,
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(dir, async () => {
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const trackerDir = path.join(dir, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      await cmdSync(args);

      fs.rmSync(storeDb, { force: true });
      createStoreSchema(storeDb);
      insertUsage(storeDb, {
        id: 1,
        session_id: sessionId,
        model: "gpt-5.6-luna",
        input_tokens: 30,
        output_tokens: 3,
        token_details_json: tokenDetails({ input: 3, cacheWrite: 27, output: 3 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      fs.rmSync(appDb, { force: true });
      fs.writeFileSync(appDb, "not sqlite", "utf8");
      await cmdSync(args);
      let cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 1);
      assert.equal(
        readQueue(queuePath).reduce((sum, row) => sum + row.total_tokens, 0),
        22 + 33,
      );

      insertUsage(storeDb, {
        id: 2,
        session_id: sessionId,
        model: "gpt-5.6-terra",
        input_tokens: 10,
        output_tokens: 1,
        token_details_json: tokenDetails({ input: 1, cacheWrite: 9, output: 1 }),
        created_at: "2026-07-10T11:00:00Z",
      });
      await cmdSync(args);
      const rows = readQueue(queuePath);
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 22 + 44);
      cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 2);

      const beforeRepeat = fs.readFileSync(queuePath, "utf8");
      await cmdSync(args);
      assert.equal(fs.readFileSync(queuePath, "utf8"), beforeRepeat);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows reset reconciliation preserves the store path's original casing", async (t) => {
  mockPlatform(t, "win32");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-win-case-"));
  const home = path.join(root, "MixedCaseHome");
  const copilotHome = path.join(home, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  const storeDb = path.join(copilotHome, "session-store.db");
  createStoreSchema(storeDb);
  insertUsage(storeDb, {
    id: 1,
    session_id: "windows-case-session",
    model: "gpt-5.6-luna",
    input_tokens: 20,
    output_tokens: 2,
    token_details_json: tokenDetails({ input: 20, output: 2 }),
    created_at: "2026-07-10T10:00:00Z",
  });
  const appDb = makeAppDb(copilotHome, {
    id: "windows-case-session",
    model: "gpt-5.6-luna",
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    total_input_tokens: 20,
    total_output_tokens: 2,
    total_cached_tokens: 0,
    total_reasoning_tokens: 0,
  });
  try {
    await withSyncHome(home, async () => {
      process.env.TOKENTRACKER_WSL_MODE = "native-only";
      const args = ["--auto", "--from-retry", "--source=copilot"];
      const cursorsPath = path.join(
        home,
        ".tokentracker",
        "tracker",
        "cursors.json",
      );
      await cmdSync(args);

      fs.rmSync(storeDb, { force: true });
      createStoreSchema(storeDb);
      insertUsage(storeDb, {
        id: 1,
        session_id: "windows-case-session",
        model: "gpt-5.6-luna",
        input_tokens: 30,
        output_tokens: 3,
        token_details_json: tokenDetails({ input: 30, output: 3 }),
        created_at: "2026-07-10T10:30:00Z",
      });
      updateAppUsage(appDb, "windows-case-session", {
        updated_at: "2026-07-10T10:30:00Z",
        total_input_tokens: 30,
        total_output_tokens: 3,
      });
      await cmdSync(args);

      const cursors = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      assert.equal(cursors.copilotStore.dbs[storeDb].lastId, 1);
      const rows = readQueue(
        path.join(home, ".tokentracker", "tracker", "queue.jsonl"),
      );
      assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 22 + 33);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
