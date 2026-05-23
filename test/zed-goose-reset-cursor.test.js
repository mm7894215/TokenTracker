/**
 * Regression tests for two review findings:
 *
 *   1. Cumulative reset detection (Zed/Goose) — `Math.max(0, curr - prev)`
 *      silently swallows resets. We must detect curr < prev and emit curr
 *      as a fresh-start delta, otherwise the next sync re-counts the
 *      reset thread/session from zero.
 *
 *   2. Zed incremental cursor — only advance the lastUpdatedAt watermark
 *      past rows we actually recorded in threadTotals (zed.dev). A
 *      non-zed.dev (external ACP) row with a *future* updated_at must
 *      not push the cursor forward, otherwise a later-inserted zed.dev
 *      thread with an earlier timestamp gets filtered out forever.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const cp = require("node:child_process");

const { parseZedIncremental, parseGooseIncremental } = require("../src/lib/rollout");

// ── Zed fixtures ──────────────────────────────────────────────────────────

async function zstdCompress(data) {
  if (typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(data);
  }
  return Buffer.from(await require("@mongodb-js/zstd").compress(data));
}

async function makeZedDb({ rows }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-reset-"));
  const dbPath = path.join(dir, "threads.db");
  cp.execFileSync("sqlite3", [
    dbPath,
    "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT);",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  for (const r of rows) await insertZedRow(dbPath, r);
  return { dir, dbPath };
}

async function insertZedRow(dbPath, { id, updated_at, totals }) {
  const json = JSON.stringify({
    request_token_usage: { r1: totals },
    model: { provider: "zed.dev", model: "claude-sonnet-4" },
    imported: false,
  });
  const data = await zstdCompress(Buffer.from(json));
  cp.execFileSync("sqlite3", [
    dbPath,
    `INSERT OR REPLACE INTO threads (id, updated_at, data_type, data, created_at) VALUES ('${id}', '${updated_at}', 'zstd', X'${data.toString("hex")}', '${updated_at}');`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

test("Zed: cumulative reset is emitted as a fresh-start delta, not lost", async () => {
  const { dir, dbPath } = await makeZedDb({
    rows: [
      { id: "th-r", updated_at: "2026-05-01T10:00:00Z", totals: { input_tokens: 1000, output_tokens: 200 } },
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  // Run 1: initial cumulative
  await parseZedIncremental({ dbPath, cursors, queuePath });

  // Now simulate a reset: same thread id, much smaller totals.
  cp.execFileSync("sqlite3", [dbPath, "DELETE FROM threads WHERE id='th-r';"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await insertZedRow(dbPath, {
    id: "th-r",
    updated_at: "2026-05-01T12:00:00Z",
    totals: { input_tokens: 50, output_tokens: 10 }, // 60 << 1200 (reset)
  });

  const res = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res.eventsAggregated, 1, "reset must produce a fresh-start emit (not 0-delta skip)");

  // The reset row's updated_at moves to 12:00, which falls in a different
  // half-hour bucket than the original 10:00 emit. So the latest queue
  // row holds the reset's fresh 50/10 — the prior 1000/200 still lives
  // in the earlier bucket. Bug-free path: 50 input emitted; legacy
  // (clamp-to-0) path: 0 input emitted (silent data loss).
  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((r) => r.source === "zed");
  const last = rows[rows.length - 1];
  assert.equal(last.input_tokens, 50);
  assert.equal(last.output_tokens, 10);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Zed: non-zed.dev row's updated_at must not advance the lastUpdatedAt cursor", async () => {
  // Order: insert a non-zed.dev row at 2026-05-02 (LATER), and a zed.dev
  // row at 2026-05-01 (EARLIER). If cursor advances past 2026-05-02, the
  // zed.dev row drops out of the next sync's WHERE updated_at > cursor.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-cursor-"));
  const dbPath = path.join(dir, "threads.db");
  cp.execFileSync("sqlite3", [
    dbPath,
    "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT);",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // External ACP row (provider != zed.dev): updated_at far in the future
  const acpJson = JSON.stringify({
    request_token_usage: { r1: { input_tokens: 9999, output_tokens: 1 } },
    model: { provider: "openai", model: "gpt-4o" },
    imported: false,
  });
  cp.execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO threads (id, updated_at, data_type, data, created_at) VALUES ('acp', '2026-05-02T00:00:00Z', 'json', X'${Buffer.from(acpJson).toString("hex")}', '2026-05-02T00:00:00Z');`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // zed.dev row at earlier timestamp
  await insertZedRow(dbPath, {
    id: "zed-1",
    updated_at: "2026-05-01T00:00:00Z",
    totals: { input_tokens: 100, output_tokens: 20 },
  });

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  // Run 1: should aggregate zed-1 (1 event); cursor advance only to
  // zed-1's timestamp, NOT to acp's later timestamp.
  const res1 = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res1.eventsAggregated, 1);
  assert.equal(
    cursors.zed.lastUpdatedAt,
    "2026-05-01T00:00:00Z",
    "cursor must only advance over rows recorded in threadTotals (zed.dev)",
  );

  // Run 2: if cursor were 2026-05-02, zed-1 would be filtered out; here
  // it's not, but cumulative-delta gates it to 0 events. The point is
  // cursor stays small enough that a future-imported old zed.dev thread
  // would still be readable.
  const res2 = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res2.eventsAggregated, 0, "no new growth → no new events");

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Goose ────────────────────────────────────────────────────────────────

test("Goose: cumulative reset is emitted as a fresh-start delta", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-reset-"));
  const dbPath = path.join(dir, "sessions.db");
  cp.execFileSync("sqlite3", [
    dbPath,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model_config_json TEXT,
      provider_name TEXT,
      created_at TEXT NOT NULL,
      total_tokens INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      accumulated_total_tokens INTEGER,
      accumulated_input_tokens INTEGER,
      accumulated_output_tokens INTEGER
    );`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  cp.execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO sessions (id, model_config_json, provider_name, created_at, accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens)
     VALUES ('sess-r', '{"model_name":"claude-3-7-sonnet"}', 'anthropic', '2026-05-01T10:00:00Z', 10000, 8000, 2000);`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  await parseGooseIncremental({ dbPath, cursors, queuePath });

  // Reset: same id, much smaller totals
  cp.execFileSync("sqlite3", [
    dbPath,
    "UPDATE sessions SET accumulated_total_tokens=300, accumulated_input_tokens=250, accumulated_output_tokens=50 WHERE id='sess-r';",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const res = await parseGooseIncremental({ dbPath, cursors, queuePath });
  assert.equal(res.eventsAggregated, 1, "reset must produce a fresh-start emit (not 0-delta skip)");

  // Goose's bucket is keyed on created_at, which doesn't change on reset.
  // So the same bucket gets two deltas: 8000/2000 (run 1) + 250/50 (reset
  // emit). Latest cumulative: 8250/2050. Legacy (clamp-to-0) path would
  // leave the bucket frozen at 8000/2000 and silently lose 250 tokens of
  // post-reset usage.
  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((r) => r.source === "goose");
  const last = rows[rows.length - 1];
  assert.equal(last.input_tokens, 8000 + 250);
  assert.equal(last.output_tokens, 2000 + 50);

  fs.rmSync(dir, { recursive: true, force: true });
});
