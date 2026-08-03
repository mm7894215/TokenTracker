/**
 * Kiro CLI WSL dual-install support (#306).
 *
 * Verifies:
 *   - multiInstallParse with per-install env (KIRO_CLI_DB_PATH / KIRO_HOME)
 *     keeps cursors.kiroCli.requests and watermark state namespaced per
 *     install with no cross-pollution
 *   - kiroCliInstallOwnsCursor probes request_ids inside the
 *     conversations_v2 JSON payload, filters synthetic session keys, and
 *     fails safe on missing evidence
 *   - resolveKiroCliDbPath platform branches (win32 / linux / darwin /
 *     explicit override)
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runSql } = require("./helpers/sqlite-write");
const { mockPlatform } = require("./helpers/mock");

const { multiInstallParse } = require("../src/lib/multi-install-parser");
const {
  parseKiroCliIncremental,
  kiroCliInstallOwnsCursor,
  resolveKiroCliDbPath,
} = require("../src/lib/rollout");

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Creates a kiro-cli data.sqlite3 with conversations_v2 rows.
// convs: [{ conversationId, requests: [{ requestId, messageId, promptLen, responseLen, tsMs }] }]
function makeCliDb(dbPath, convs) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const inserts = convs
    .map((c) => {
      const value = JSON.stringify({
        model_info: { model_id: null },
        user_turn_metadata: {
          continuation_id: null,
          requests: c.requests.map((r) => ({
            request_id: r.requestId,
            message_id: r.messageId,
            user_prompt_length: r.promptLen,
            response_size: r.responseLen,
            model_id: null,
            request_start_timestamp_ms: r.tsMs,
          })),
        },
      }).replace(/'/g, "''");
      return `INSERT INTO conversations_v2 (conversation_id, value) VALUES ('${c.conversationId}', '${value}');`;
    })
    .join("\n");
  runSql(
    dbPath,
    `CREATE TABLE conversations_v2 (conversation_id TEXT PRIMARY KEY, value TEXT);\n${inserts}`,
  );
  return dbPath;
}

// Per-install env: DB and sessions home must BOTH point inside the install so
// nothing falls back to the developer machine's real ~/.kiro.
function makeInstallEnv(root) {
  return {
    HOME: root,
    KIRO_CLI_DB_PATH: path.join(root, "data.sqlite3"),
    KIRO_HOME: path.join(root, ".kiro"),
  };
}

// queue.jsonl is append-only and buckets carry cumulative absolutes; readers
// take the LATEST entry per (source, model, hour_start).
function sumLatestPerBucket(rows, field) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()].reduce((s, r) => s + (r[field] || 0), 0);
}

test("kiro CLI dual-install: request cursors namespaced per install", async (t) => {
  const dir = tmpdir(t, "kirocli-dual-");
  const nativeRoot = path.join(dir, "native");
  const wslRoot = path.join(dir, "wsl");
  // Anchor all requests inside ONE half-hour bucket (an hour ago, aligned) so
  // the latest-per-bucket assertion is deterministic and recent enough to
  // clear the 90-day watermark.
  const bucketBase = Math.floor(Date.now() / 1_800_000) * 1_800_000 - 3_600_000;

  makeCliDb(path.join(nativeRoot, "data.sqlite3"), [
    {
      conversationId: "conv-native",
      requests: [
        { requestId: "req-n1", messageId: "msg-n1", promptLen: 400, responseLen: 200, tsMs: bucketBase + 60_000 },
        { requestId: "req-n2", messageId: "msg-n2", promptLen: 800, responseLen: 400, tsMs: bucketBase + 120_000 },
      ],
    },
  ]);
  makeCliDb(path.join(wslRoot, "data.sqlite3"), [
    {
      conversationId: "conv-wsl",
      requests: [
        { requestId: "req-w1", messageId: "msg-w1", promptLen: 1200, responseLen: 600, tsMs: bucketBase + 180_000 },
      ],
    },
  ]);

  const nativeEnv = makeInstallEnv(nativeRoot);
  const wslEnv = makeInstallEnv(wslRoot);
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  // Paths are install markers; the parser resolves everything from env.
  // env MUST flow through getParams — a shared top-level env would clobber it.
  const result = await multiInstallParse({
    paths: { native: nativeEnv.KIRO_CLI_DB_PATH, wsl: wslEnv.KIRO_CLI_DB_PATH },
    parserFn: parseKiroCliIncremental,
    providerName: "kiroCli",
    cursors,
    getParams: (_p, key) => ({ env: key === "wsl" ? wslEnv : nativeEnv }),
    queuePath,
  });

  assert.ok(result.recordsProcessed >= 3, `3 requests total, got ${result.recordsProcessed}`);
  const nativeReqs = Object.keys(cursors.kiroCli.native.requests || {});
  const wslReqs = Object.keys(cursors.kiroCli.wsl.requests || {});
  assert.deepEqual(nativeReqs.sort(), ["req-n1", "req-n2"], "native namespace holds only its own requests");
  assert.deepEqual(wslReqs, ["req-w1"], "wsl namespace holds only its own requests");

  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.source === "kiro"));
  // 4 chars/token: (400+800+1200)/4 = 600 input tokens across both installs.
  assert.equal(sumLatestPerBucket(rows, "input_tokens"), 600, "both installs aggregated, no double count");

  // Second run: fingerprints unchanged → no new contributions.
  const again = await multiInstallParse({
    paths: { native: nativeEnv.KIRO_CLI_DB_PATH, wsl: wslEnv.KIRO_CLI_DB_PATH },
    parserFn: parseKiroCliIncremental,
    providerName: "kiroCli",
    cursors,
    getParams: (_p, key) => ({ env: key === "wsl" ? wslEnv : nativeEnv }),
    queuePath,
  });
  assert.equal(again.eventsAggregated, 0, "second run adds nothing");
});

test("kiroCliInstallOwnsCursor: probes request_ids inside the JSON payload", (t) => {
  const dir = tmpdir(t, "kirocli-probe-");
  const now = Date.now();
  const dbPath = makeCliDb(path.join(dir, "data.sqlite3"), [
    {
      conversationId: "conv-1",
      requests: [
        { requestId: "req-abc", messageId: "m1", promptLen: 4, responseLen: 4, tsMs: now },
      ],
    },
  ]);

  assert.equal(kiroCliInstallOwnsCursor(dbPath, { requests: { "req-abc": {} } }), true);
  assert.equal(kiroCliInstallOwnsCursor(dbPath, { requests: { "req-foreign": {} } }), false);
  // Synthetic `${sessionId}:${loopRand}` session-file keys never exist in
  // SQLite — they must be filtered out, leaving no evidence here.
  assert.equal(kiroCliInstallOwnsCursor(dbPath, { requests: { "sess-1:rand9": {} } }), false);
  // Watermark-only cursor → no evidence
  assert.equal(kiroCliInstallOwnsCursor(dbPath, { watermarkMs: now }), false);
  assert.equal(kiroCliInstallOwnsCursor(dbPath, {}), false);
  assert.equal(kiroCliInstallOwnsCursor(path.join(dir, "missing.sqlite3"), { requests: { "req-abc": {} } }), false);
  // Quote characters are escaped, not executed
  assert.equal(kiroCliInstallOwnsCursor(dbPath, { requests: { "x'); DROP TABLE conversations_v2;--": {} } }), false);
});

// NOTE: one mockPlatform call per test — repeated t.mock.property on the same
// property in a single test hangs the process at teardown (Node 24).
test("resolveKiroCliDbPath: explicit override wins on every platform", () => {
  const p = resolveKiroCliDbPath({ KIRO_CLI_DB_PATH: "/custom/db.sqlite3" });
  assert.equal(p, "/custom/db.sqlite3");
});

test("resolveKiroCliDbPath: win32 branch", (t) => {
  mockPlatform(t, "win32");
  const p = resolveKiroCliDbPath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
  assert.ok(p.includes("kiro-cli"));
  assert.ok(p.includes("AppData"));
  assert.ok(p.endsWith("data.sqlite3"));
  const fallback = resolveKiroCliDbPath({ HOME: "/win-home" });
  assert.equal(fallback, path.join("/win-home", "AppData", "Local", "kiro-cli", "data.sqlite3"));
});

test("resolveKiroCliDbPath: linux branch", (t) => {
  mockPlatform(t, "linux");
  const p = resolveKiroCliDbPath({ XDG_DATA_HOME: "/home/u/.local/share" });
  assert.equal(p, path.join("/home/u/.local/share", "kiro-cli", "data.sqlite3"));
  const fallback = resolveKiroCliDbPath({ HOME: "/home/u" });
  assert.equal(fallback, path.join("/home/u", ".local", "share", "kiro-cli", "data.sqlite3"));
});

test("resolveKiroCliDbPath: darwin branch", (t) => {
  mockPlatform(t, "darwin");
  const p = resolveKiroCliDbPath({ HOME: "/Users/u" });
  assert.equal(
    p,
    path.join("/Users/u", "Library", "Application Support", "kiro-cli", "data.sqlite3"),
  );
});
