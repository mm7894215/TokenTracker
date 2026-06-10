/**
 * Zed Agent parser test.
 *
 * Builds a synthetic threads.db SQLite file (mirroring Zed's real schema
 * including data_type='zstd' compressed blobs) and verifies:
 *   - All providers counted (hosted "zed.dev" + bring-your-own), with the
 *     ZED_DOUBLE_COUNTED_PROVIDERS skip
 *   - request_token_usage > cumulative_token_usage precedence
 *   - zstd decompression of blob payloads
 *   - Cumulative-delta accounting across sync runs (no double-count)
 *   - PRAGMA table_info-driven optional columns (created_at can be missing)
 *
 * Local machine has no Zed install, so fixtures are written under a tempdir
 * and passed via TOKENTRACKER_ZED_DB.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const cp = require("node:child_process");

const {
  resolveZedDbPath,
  decodeZedThreadBlob,
  extractZedTotals,
  readZedUsage,
  sumZedRequestUsage,
  parseZedIncremental,
} = require("../src/lib/rollout");

async function zstdCompress(data) {
  if (typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(data);
  }
  return Buffer.from(await require("@mongodb-js/zstd").compress(data));
}

async function makeDb({ rows, withCreatedAt = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-test-"));
  const dbPath = path.join(dir, "threads.db");
  const createdAtCol = withCreatedAt ? ", created_at TEXT" : "";
  const schema = `CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL${createdAtCol});`;
  cp.execFileSync("sqlite3", [dbPath, schema], { stdio: ["ignore", "ignore", "pipe"] });

  for (const row of rows) {
    const blob = row.compressed
      ? await zstdCompress(Buffer.from(row.json))
      : Buffer.from(row.json);
    const hex = blob.toString("hex");
    const cols = withCreatedAt
      ? "id, updated_at, data_type, data, created_at"
      : "id, updated_at, data_type, data";
    const vals = withCreatedAt
      ? `'${row.id}', '${row.updatedAt}', '${row.dataType}', X'${hex}', '${row.createdAt || row.updatedAt}'`
      : `'${row.id}', '${row.updatedAt}', '${row.dataType}', X'${hex}'`;
    cp.execFileSync("sqlite3", [dbPath, `INSERT INTO threads (${cols}) VALUES (${vals});`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  return { dir, dbPath };
}

function threadJson({ provider = "zed.dev", model = "claude-sonnet-4", usage, cumulative, imported = false, updatedAt = "2026-05-01T12:00:00Z" } = {}) {
  return JSON.stringify({
    version: "0.3.0",
    title: "test",
    messages: [],
    updated_at: updatedAt,
    request_token_usage: usage || {},
    cumulative_token_usage: cumulative || {},
    model: { provider, model },
    imported,
  });
}

test("resolveZedDbPath honors TOKENTRACKER_ZED_DB override", () => {
  const p = resolveZedDbPath({ TOKENTRACKER_ZED_DB: "/tmp/custom-zed.db" });
  assert.equal(p, "/tmp/custom-zed.db");
});

test("decodeZedThreadBlob handles json and zstd, rejects unknown", async () => {
  const json = await decodeZedThreadBlob({ dataType: "json", data: Buffer.from('{"a":1}') });
  assert.equal(json, '{"a":1}');
  const z = await zstdCompress(Buffer.from('{"b":2}'));
  assert.equal(await decodeZedThreadBlob({ dataType: "zstd", data: z }), '{"b":2}');
  await assert.rejects(() => decodeZedThreadBlob({ dataType: "bogus", data: Buffer.alloc(0) }));
});

test("decodeZedThreadBlob falls back when native zstd is unavailable", async () => {
  const z = await zstdCompress(Buffer.from('{"fallback":true}'));
  const original = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = undefined;
  try {
    assert.equal(await decodeZedThreadBlob({ dataType: "zstd", data: z }), '{"fallback":true}');
  } finally {
    zlib.zstdDecompressSync = original;
  }
});

test("extractZedTotals: skip imported + missing model; count all providers", () => {
  assert.equal(extractZedTotals(null), null);
  assert.equal(
    extractZedTotals(JSON.parse(threadJson({ imported: true, usage: { r1: { input_tokens: 1, output_tokens: 1 } } }))),
    null,
  );
  assert.equal(
    extractZedTotals(JSON.parse(threadJson({ model: "", usage: { r1: { input_tokens: 1 } } }))),
    null,
  );
  // Bring-your-own provider (formerly dropped by the hosted-only filter) is now
  // counted, attributed to its real model.
  const byo = extractZedTotals(
    JSON.parse(
      threadJson({ provider: "copilot_chat", model: "gpt-5.5", usage: { r1: { input_tokens: 10, output_tokens: 2 } } }),
    ),
  );
  assert.deepEqual(byo, {
    totals: { input: 10, output: 2, cache_read: 0, cache_write: 0 },
    model: "gpt-5.5",
  });
  // Hosted (zed.dev) threads are still counted, unchanged.
  const hosted = extractZedTotals(
    JSON.parse(threadJson({ provider: "zed.dev", model: "claude-sonnet-4", usage: { r1: { input_tokens: 4 } } })),
  );
  assert.deepEqual(hosted, { totals: { input: 4, output: 0, cache_read: 0, cache_write: 0 }, model: "claude-sonnet-4" });
});

test("extractZedTotals: prefer summed request_token_usage over cumulative", () => {
  const out = extractZedTotals(
    JSON.parse(
      threadJson({
        model: "claude-sonnet-4",
        usage: {
          r1: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
          r2: { input_tokens: 50, output_tokens: 10 },
        },
        cumulative: { input_tokens: 99999, output_tokens: 99999 },
      }),
    ),
  );
  assert.deepEqual(out, {
    model: "claude-sonnet-4",
    totals: { input: 150, output: 30, cache_read: 5, cache_write: 2 },
  });
});

test("extractZedTotals: fall back to cumulative when request_token_usage empty", () => {
  const out = extractZedTotals(
    JSON.parse(threadJson({ model: "gpt-4o", cumulative: { input_tokens: 7, output_tokens: 3 } })),
  );
  assert.equal(out.model, "gpt-4o");
  assert.equal(out.totals.input + out.totals.output, 10);
});

test("readZedUsage coerces strings + nulls + missing fields", () => {
  assert.deepEqual(readZedUsage({ input_tokens: "42", output_tokens: 8 }), {
    input: 42,
    output: 8,
    cache_read: 0,
    cache_write: 0,
  });
  assert.equal(readZedUsage(null), null);
});

test("sumZedRequestUsage handles map vs array vs missing", () => {
  assert.deepEqual(sumZedRequestUsage(null), { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  assert.deepEqual(
    sumZedRequestUsage([{ input_tokens: 1 }, { input_tokens: 2, output_tokens: 5 }]),
    { input: 3, output: 5, cache_read: 0, cache_write: 0 },
  );
  assert.deepEqual(
    sumZedRequestUsage({ a: { input_tokens: 10 }, b: { input_tokens: 20 } }),
    { input: 30, output: 0, cache_read: 0, cache_write: 0 },
  );
});

test("parseZedIncremental: aggregates hosted + BYO providers, deltas across runs", async () => {
  const { dir, dbPath } = await makeDb({
    rows: [
      {
        id: "th-a",
        updatedAt: "2026-05-01T14:00:00Z",
        createdAt: "2026-05-01T13:00:00Z",
        dataType: "zstd",
        compressed: true,
        json: threadJson({
          model: "claude-sonnet-4",
          usage: { r1: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100 } },
        }),
      },
      {
        // Bring-your-own provider — formerly dropped, now counted.
        id: "th-b-byo",
        updatedAt: "2026-05-01T15:00:00Z",
        createdAt: "2026-05-01T15:00:00Z",
        dataType: "json",
        compressed: false,
        json: threadJson({
          provider: "copilot_chat",
          model: "gpt-4o",
          usage: { r1: { input_tokens: 9999, output_tokens: 1 } },
        }),
      },
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  // ── Run 1 ──
  const res1 = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res1.recordsProcessed, 2, "iterated both rows");
  assert.equal(res1.eventsAggregated, 2, "hosted + BYO both aggregated");
  assert.equal(res1.bucketsQueued, 2);

  const rows1 = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((r) => r.source === "zed");
  assert.equal(rows1.length, 2);
  const claudeRow = rows1.find((r) => r.model === "claude-sonnet-4");
  const byoRow = rows1.find((r) => r.model === "gpt-4o");
  assert.ok(claudeRow && byoRow, "both a hosted and a BYO row are emitted");
  assert.equal(claudeRow.input_tokens, 1000);
  assert.equal(claudeRow.output_tokens, 200);
  assert.equal(claudeRow.cached_input_tokens, 100);
  assert.equal(claudeRow.total_tokens, 1300);
  assert.equal(byoRow.input_tokens, 9999);
  assert.equal(byoRow.total_tokens, 10000);

  // ── Run 2 (same DB, no thread changes) → zero delta ──
  const res2 = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res2.eventsAggregated, 0, "no delta on second run");

  // ── Run 3: thread th-a grows; we must enqueue only the delta ──
  cp.execFileSync("sqlite3", [
    dbPath,
    "DELETE FROM threads WHERE id='th-a';",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // Threads grow with an advancing updated_at; this must be after the BYO
  // thread's 15:00 timestamp (which set the incremental watermark in run 1).
  const grownJson = threadJson({
    model: "claude-sonnet-4",
    usage: {
      r1: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100 },
      r2: { input_tokens: 500, output_tokens: 80 },
    },
    updatedAt: "2026-05-01T16:00:00Z",
  });
  const grown = await zstdCompress(Buffer.from(grownJson));
  cp.execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO threads (id, updated_at, data_type, data, created_at) VALUES ('th-a', '2026-05-01T16:00:00Z', 'zstd', X'${grown.toString("hex")}', '2026-05-01T13:00:00Z');`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const res3 = await parseZedIncremental({ dbPath, cursors, queuePath });
  assert.equal(res3.eventsAggregated, 1);
  const rows3 = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((r) => r.source === "zed");
  // claude rows total = initial 1300 + grow delta 580; BYO row = 10000. Each
  // delta is enqueued once — no full-cumulative re-count.
  const claudeTotal = rows3.filter((r) => r.model === "claude-sonnet-4").reduce((s, r) => s + r.total_tokens, 0);
  assert.equal(claudeTotal, 1300 + 580, "delta only, not full cumulative");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseZedIncremental: BYO request_token_usage map keyed by request-id (real shape)", async () => {
  // Mirrors the real on-disk shape: request_token_usage is a map of
  // request-uuid -> usage, cumulative_token_usage is empty.
  const { dir, dbPath } = await makeDb({
    rows: [
      {
        id: "th-copilot",
        updatedAt: "2026-06-07T17:25:00Z",
        createdAt: "2026-06-07T17:00:00Z",
        dataType: "zstd",
        compressed: true,
        json: JSON.stringify({
          version: "0.3.0",
          updated_at: "2026-06-07T17:25:00Z",
          model: { provider: "openai-subscribed", model: "gpt-5.5" },
          request_token_usage: {
            "af7eb9b5-3e26-4c17-8981-8c5385a64c69": {
              input_tokens: 1100,
              output_tokens: 626,
              cache_read_input_tokens: 50176,
            },
            "6b5416d5-9d7a-4170-a34b-e03c98a046b7": {
              input_tokens: 41884,
              output_tokens: 533,
              cache_read_input_tokens: 48640,
            },
          },
          cumulative_token_usage: {},
        }),
      },
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const res = await parseZedIncremental({ dbPath, cursors: {}, queuePath });
  assert.equal(res.eventsAggregated, 1, "BYO thread counted");
  const row = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((r) => r.source === "zed");
  assert.equal(row.model, "gpt-5.5");
  assert.equal(row.input_tokens, 1100 + 41884);
  assert.equal(row.output_tokens, 626 + 533);
  assert.equal(row.cached_input_tokens, 50176 + 48640);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseZedIncremental: tolerates schema without created_at column (older Zed)", async () => {
  const { dir, dbPath } = await makeDb({
    withCreatedAt: false,
    rows: [
      {
        id: "th-x",
        updatedAt: "2026-04-01T10:00:00Z",
        dataType: "json",
        compressed: false,
        json: threadJson({
          model: "claude-opus-4",
          usage: { r1: { input_tokens: 42, output_tokens: 9 } },
          updatedAt: "2026-04-01T10:00:00Z",
        }),
      },
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const res = await parseZedIncremental({ dbPath, cursors: {}, queuePath });
  assert.equal(res.eventsAggregated, 1, "must work without created_at");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseZedIncremental: missing DB is a no-op (not an error)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-missing-"));
  const queuePath = path.join(dir, "queue.jsonl");
  const res = await parseZedIncremental({
    dbPath: path.join(dir, "no-such-db.db"),
    cursors: {},
    queuePath,
  });
  assert.deepEqual(res, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
