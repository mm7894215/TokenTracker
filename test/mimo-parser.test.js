const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { test } = require("node:test");

const {
  parseOpencodeDbIncremental,
  readMimoDbMessages,
} = require("../src/lib/rollout");

// ─────────────────────────────────────────────────────────────────────────────
// Mimo — mimocode (Xiaomi MiMo, OpenCode-fork SQLite at ~/.local/share/mimocode/mimocode.db)
//
// Reuses the OpenCode `message` table schema, BUT mimocode also imports the
// user's existing Claude Code history into its own DB (recorded in the
// `claude_import` table). Those imported rows are already counted by the Claude
// parser, so readMimoDbMessages must skip them — otherwise real Claude usage is
// double-counted and mislabeled as "mimo". Only native mimo-generated messages
// are counted; per-model pricing applies as-is.
// ─────────────────────────────────────────────────────────────────────────────

function buildMimoDb(dbPath, messageRows, importRows) {
  const schema = `
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE claude_import (
      source_uuid text PRIMARY KEY,
      session_id text NOT NULL,
      source_path text NOT NULL,
      source_mtime integer NOT NULL,
      time_imported integer NOT NULL,
      message_ids text
    );
  `;
  cp.execFileSync("sqlite3", [dbPath, schema], { encoding: "utf8" });
  for (const row of messageRows) {
    const dataJson = JSON.stringify(row.data).replace(/'/g, "''");
    const sql = `INSERT INTO message VALUES('${row.id}','${row.session_id}',${row.time_created},${row.time_updated},'${dataJson}');`;
    cp.execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  }
  for (const row of importRows || []) {
    const idsCol =
      row.message_ids == null
        ? "NULL"
        : `'${JSON.stringify(row.message_ids).replace(/'/g, "''")}'`;
    const sql = `INSERT INTO claude_import VALUES('${row.source_uuid}','${row.session_id}','${row.source_path}',${row.source_mtime},${row.time_imported},${idsCol});`;
    cp.execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  }
}

function assistantRow(id, sessionID, modelID, providerID, tokens, ts) {
  return {
    id,
    session_id: sessionID,
    time_created: ts,
    time_updated: ts + 1,
    data: {
      id,
      sessionID,
      role: "assistant",
      modelID,
      providerID,
      cost: 0,
      tokens,
      time: { created: ts, completed: ts + 100 },
      path: { cwd: "/tmp/proj", root: "/tmp/proj" },
    },
  };
}

test("Mimo: readMimoDbMessages excludes imported Claude history, keeps only native messages", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-mimo-"));
  try {
    const dbPath = path.join(tmp, "mimocode.db");
    const ts = 1780538800000;
    buildMimoDb(
      dbPath,
      [
        // Imported Claude Code session (huge — already counted as source=claude).
        assistantRow(
          "msg_imported_001",
          "ses_import_a",
          "claude-opus-4-8",
          "anthropic",
          { input: 1000, output: 5000, reasoning: 0, cache: { read: 900000, write: 50000 }, total: 956000 },
          ts,
        ),
        // Native mimo usage (the only thing that should be counted).
        assistantRow(
          "msg_native_001",
          "ses_native_a",
          "mimo-auto",
          "mimo",
          { input: 500, output: 25, reasoning: 0, cache: { read: 100, write: 0 }, total: 625 },
          ts + 1000,
        ),
        assistantRow(
          "msg_native_002",
          "ses_native_a",
          "mimo-v2.5-pro",
          "xiaomi",
          { input: 200, output: 50, reasoning: 0, cache: { read: 0, write: 0 }, total: 250 },
          ts + 2000,
        ),
      ],
      [
        {
          source_uuid: "uuid-1",
          session_id: "ses_import_a",
          source_path: "/Users/x/.claude/projects/-Users-x-proj/abc.jsonl",
          source_mtime: ts,
          time_imported: ts,
          message_ids: ["msg_imported_user_0", "msg_imported_001"],
        },
      ],
    );

    const dbMessages = readMimoDbMessages(dbPath);
    // Imported claude-opus message must be gone; both native ones remain.
    assert.equal(dbMessages.length, 2);
    const ids = new Set(dbMessages.map((m) => m.id));
    assert.ok(!ids.has("msg_imported_001"), "imported Claude message must be excluded");
    assert.ok(ids.has("msg_native_001"));
    assert.ok(ids.has("msg_native_002"));

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    const result = await parseOpencodeDbIncremental({
      dbMessages,
      cursors,
      queuePath,
      source: "mimo",
      cursorKey: "mimo",
    });
    assert.equal(result.eventsAggregated, 2);
    assert.ok(result.bucketsQueued > 0);

    // State persisted under the dedicated mimo namespace.
    assert.ok(cursors.mimo);
    assert.ok(cursors.mimo.messages["ses_native_a|msg_native_001"]);

    const queueLines = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const sources = new Set(queueLines.map((r) => r.source));
    const models = new Set(queueLines.map((r) => r.model));
    assert.deepEqual([...sources].sort(), ["mimo"]);
    assert.ok(models.has("mimo-auto"));
    assert.ok(models.has("mimo-v2.5-pro"));
    assert.ok(!models.has("claude-opus-4-8"), "imported Claude model must not appear");

    // Only native tokens counted: 625 + 250 (the 956k imported row is excluded).
    const totalAll = queueLines.reduce((acc, r) => acc + (r.total_tokens || 0), 0);
    assert.equal(totalAll, 625 + 250);

    // Idempotent re-run.
    const result2 = await parseOpencodeDbIncremental({
      dbMessages,
      cursors,
      queuePath,
      source: "mimo",
      cursorKey: "mimo",
    });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Mimo: legacy claude_import rows without message_ids are excluded by session_id", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-mimo-legacy-"));
  try {
    const dbPath = path.join(tmp, "mimocode.db");
    const ts = 1780538800000;
    buildMimoDb(
      dbPath,
      [
        // Imported Claude session whose import row predates the message_ids
        // column (message_ids NULL) — must still be excluded via session_id.
        assistantRow(
          "msg_legacy_imported_1",
          "ses_legacy_import",
          "claude-opus-4-8",
          "anthropic",
          { input: 100, output: 200, reasoning: 0, cache: { read: 500000, write: 0 }, total: 500300 },
          ts,
        ),
        // Native mimo turn in its own session — must be kept.
        assistantRow(
          "msg_native_x",
          "ses_native_x",
          "mimo-auto",
          "mimo",
          { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 },
          ts + 1000,
        ),
      ],
      [
        {
          source_uuid: "uuid-legacy",
          session_id: "ses_legacy_import",
          source_path: "/Users/x/.claude/projects/-Users-x-proj/legacy.jsonl",
          source_mtime: ts,
          time_imported: ts,
          message_ids: null, // legacy row — column was added later
        },
      ],
    );

    const dbMessages = readMimoDbMessages(dbPath);
    const ids = new Set(dbMessages.map((m) => m.id));
    assert.equal(dbMessages.length, 1, "only the native turn should remain");
    assert.ok(!ids.has("msg_legacy_imported_1"), "legacy imported session must be excluded by session_id");
    assert.ok(ids.has("msg_native_x"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Mimo: readMimoDbMessages counts everything when claude_import is empty", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-mimo-noimport-"));
  try {
    const dbPath = path.join(tmp, "mimocode.db");
    const ts = 1780538800000;
    buildMimoDb(
      dbPath,
      [assistantRow("msg_n1", "ses_n", "mimo-auto", "mimo", { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 }, ts)],
      [], // no imports
    );
    const dbMessages = readMimoDbMessages(dbPath);
    assert.equal(dbMessages.length, 1);
    assert.equal(dbMessages[0].id, "msg_n1");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
