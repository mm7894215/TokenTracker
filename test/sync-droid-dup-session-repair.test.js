/**
 * One-time repair migration for issue #204 — Droid duplicate session-id inflation.
 *
 * Builds a polluted install (same Droid session id in two folders → one bucket
 * inflated to ~40B) and verifies repairDroidDuplicateSessionInflation:
 *   - corrects the duplicate sessions' buckets to the on-disk ground truth
 *   - removes the stale duplicate's separate half-hour bucket (E3, no residual)
 *   - preserves clean sessions AND deleted-session history byte-for-byte
 *   - preserves non-droid rows + unparseable lines verbatim
 *   - resets the upload offset, drops stale droid group markers
 *   - is idempotent (run-twice: guard short-circuits) and stable in the same sync
 *   - touches nothing on a clean install (no duplicate session ids on disk)
 */
"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  repairDroidDuplicateSessionInflation,
  DROID_DUP_SESSION_REPAIR_KEY,
} = require("../src/commands/sync");
const {
  bucketKey,
  toUtcHalfHourStart,
  parseDroidIncremental,
  listDroidSettingsFiles,
} = require("../src/lib/rollout");

const MODEL_DUP = "claude-sonnet-4-5";
const MODEL_CLEAN = "gpt-5";

function bucketFor(model, mtimeMs) {
  return bucketKey("droid", model, toUtcHalfHourStart(new Date(mtimeMs).toISOString()));
}

function totals(total) {
  return {
    input_tokens: total,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
    conversation_count: 1,
  };
}

function droidRow(model, hourStart, total) {
  return JSON.stringify({
    source: "droid",
    model,
    hour_start: hourStart,
    ...totals(total),
  });
}

function writeSettings(root, sub, id, model, totalTokens, mtimeMs) {
  const dir = path.join(root, sub);
  fssync.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.settings.json`);
  fssync.writeFileSync(
    fp,
    JSON.stringify({
      model,
      tokenUsage: {
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    }),
  );
  const t = new Date(mtimeMs);
  fssync.utimesSync(fp, t, t);
  return fp;
}

async function withDroidEnv(root, fn) {
  const prev = process.env.DROID_SESSIONS_DIR;
  process.env.DROID_SESSIONS_DIR = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DROID_SESSIONS_DIR;
    else process.env.DROID_SESSIONS_DIR = prev;
  }
}

async function readQueueRows(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8");
  const rows = [];
  const rawLines = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    rawLines.push(l);
    try {
      rows.push(JSON.parse(l));
    } catch {
      rows.push({ __unparseable: l });
    }
  }
  return { rows, rawLines };
}

// Build a polluted install: dup session id in two folders (canonical 14:00 + stale
// 15:00), a clean session (16:00), a deleted-session history bucket (no file), a
// non-droid row, and an unparseable line.
async function makePollutedInstall() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-droidrepair-"));
  const root = path.join(home, "sessions");
  const queuePath = path.join(home, "queue.jsonl");
  const queueStatePath = path.join(home, "queue.state.json");

  const CANON = 9_000_000;
  const DROPPED = 5_000_000;
  const CLEAN = 500_000;
  const DELETED = 1_000_000;

  const mtA = Date.UTC(2026, 4, 21, 14, 5, 0); // canonical → 14:00
  const mtB = Date.UTC(2026, 4, 21, 15, 10, 0); // stale dup → 15:00 (different half-hour: E3)
  const mtClean = Date.UTC(2026, 4, 21, 16, 20, 0); // clean → 16:00

  // Canonical is the LARGER cumulative; the dedup must pick it.
  const fileA = writeSettings(root, ".", "dup", MODEL_DUP, CANON, mtA);
  writeSettings(root, "proj", "dup", MODEL_DUP, DROPPED, mtB);
  const fileClean = writeSettings(root, "cleandir", "clean", MODEL_CLEAN, CLEAN, mtClean);

  const keyA = bucketFor(MODEL_DUP, mtA);
  const keyB = bucketFor(MODEL_DUP, mtB);
  const keyClean = bucketFor(MODEL_CLEAN, mtClean);
  const keyDeleted = bucketKey("droid", "claude-opus-4", "2026-05-20T10:00:00.000Z");
  const hourA = toUtcHalfHourStart(new Date(mtA).toISOString());
  const hourB = toUtcHalfHourStart(new Date(mtB).toISOString());
  const hourClean = toUtcHalfHourStart(new Date(mtClean).toISOString());

  // Inflated live hourly buckets.
  const cursors = {
    hourly: {
      buckets: {
        [keyA]: { totals: totals(30_000_000_000), queuedKey: null },
        [keyB]: { totals: totals(10_000_000_000), queuedKey: null },
        [keyClean]: { totals: totals(CLEAN), queuedKey: null },
        [keyDeleted]: { totals: totals(DELETED), queuedKey: null },
      },
      groupQueued: { [`droid|${hourA}`]: true },
    },
    droid: {
      sessionTotals: {
        dup: {
          input: DROPPED,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
          thinking: 0,
          mtimeMs: mtB,
        },
        clean: {
          input: CLEAN,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
          thinking: 0,
          mtimeMs: fssync.statSync(fileClean).mtimeMs,
        },
      },
    },
    migrations: {},
  };

  // Inflated queue: many growing rows at the dup keys + preserved rows + junk.
  const lines = [
    droidRow(MODEL_DUP, hourA, 10_000_000_000),
    droidRow(MODEL_DUP, hourA, 20_000_000_000),
    droidRow(MODEL_DUP, hourA, 30_000_000_000),
    droidRow(MODEL_DUP, hourB, 5_000_000_000),
    droidRow(MODEL_DUP, hourB, 10_000_000_000),
    droidRow(MODEL_CLEAN, hourClean, CLEAN),
    droidRow("claude-opus-4", "2026-05-20T10:00:00.000Z", DELETED),
    JSON.stringify({ source: "codex", model: "gpt-5", hour_start: hourA, ...totals(777) }),
    "{ this is not valid json",
  ];
  await fs.writeFile(queuePath, lines.join("\n") + "\n", "utf8");
  await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999, updatedAt: "x" }), "utf8");

  return {
    root,
    queuePath,
    queueStatePath,
    cursors,
    fileA,
    keys: { keyA, keyB, keyClean, keyDeleted },
    consts: { CANON, CLEAN, DELETED },
  };
}

describe("repairDroidDuplicateSessionInflation (#204)", () => {
  it("corrects dup buckets, kills the E3 residual, preserves everything else", async () => {
    const t = await makePollutedInstall();
    const ret = await withDroidEnv(t.root, () =>
      repairDroidDuplicateSessionInflation({
        cursors: t.cursors,
        queuePath: t.queuePath,
        queueStatePath: t.queueStatePath,
      }),
    );
    assert.equal(ret, true);

    // Sentinel: rich completed object.
    const sentinel = t.cursors.migrations[DROID_DUP_SESSION_REPAIR_KEY];
    assert.equal(sentinel.status, "done");
    assert.equal(sentinel.deltaReclaimed, 40_000_000_000 - t.consts.CANON);

    const b = t.cursors.hourly.buckets;
    // Canonical bucket corrected to the on-disk cumulative.
    assert.equal(b[t.keys.keyA].totals.total_tokens, t.consts.CANON);
    // E3: the stale duplicate's separate half-hour bucket is gone (no residual).
    assert.equal(b[t.keys.keyB], undefined);
    // Clean + deleted-session history preserved untouched.
    assert.equal(b[t.keys.keyClean].totals.total_tokens, t.consts.CLEAN);
    assert.equal(b[t.keys.keyDeleted].totals.total_tokens, t.consts.DELETED);
    // Stale droid group marker dropped.
    assert.deepEqual(Object.keys(t.cursors.hourly.groupQueued), []);

    // Queue: exactly one corrected canonical row, no dup rows in keyB, others kept.
    const { rows, rawLines } = await readQueueRows(t.queuePath);
    const droidA = rows.filter(
      (r) => r.source === "droid" && bucketKey("droid", r.model, r.hour_start) === t.keys.keyA,
    );
    assert.equal(droidA.length, 1);
    assert.equal(droidA[0].total_tokens, t.consts.CANON);
    const droidB = rows.filter(
      (r) => r.source === "droid" && bucketKey("droid", r.model, r.hour_start) === t.keys.keyB,
    );
    assert.equal(droidB.length, 0);
    assert.equal(
      rows.filter((r) => r.source === "droid" && bucketKey("droid", r.model, r.hour_start) === t.keys.keyClean).length,
      1,
    );
    assert.equal(
      rows.filter((r) => r.source === "droid" && bucketKey("droid", r.model, r.hour_start) === t.keys.keyDeleted).length,
      1,
    );
    assert.equal(rows.filter((r) => r.source === "codex").length, 1, "codex row preserved");
    assert.ok(rawLines.includes("{ this is not valid json"), "unparseable line preserved");

    // Upload offset reset.
    const upload = JSON.parse(await fs.readFile(t.queueStatePath, "utf8"));
    assert.equal(upload.offset, 0);
    assert.match(upload.note, /droid_dup_session/);

    // Cursor: dup overwritten with canonical truth, clean untouched.
    assert.equal(t.cursors.droid.sessionTotals.dup.input, t.consts.CANON);
    assert.equal(t.cursors.droid.sessionTotals.clean.input, t.consts.CLEAN);
  });

  it("same sync after repair: re-parsing on-disk files emits nothing", async () => {
    const t = await makePollutedInstall();
    await withDroidEnv(t.root, async () => {
      await repairDroidDuplicateSessionInflation({
        cursors: t.cursors,
        queuePath: t.queuePath,
        queueStatePath: t.queueStatePath,
      });
      const res = await parseDroidIncremental({
        settingsFiles: listDroidSettingsFiles(process.env),
        cursors: t.cursors,
        queuePath: t.queuePath,
        env: process.env,
      });
      assert.equal(res.eventsAggregated, 0, "no re-inflation in the same sync");
    });
  });

  it("run-twice: second call short-circuits on the sentinel and changes nothing", async () => {
    const t = await makePollutedInstall();
    await withDroidEnv(t.root, async () => {
      await repairDroidDuplicateSessionInflation({
        cursors: t.cursors,
        queuePath: t.queuePath,
        queueStatePath: t.queueStatePath,
      });
      const before = await fs.readFile(t.queuePath, "utf8");
      const ret2 = await repairDroidDuplicateSessionInflation({
        cursors: t.cursors,
        queuePath: t.queuePath,
        queueStatePath: t.queueStatePath,
      });
      assert.equal(ret2, false);
      assert.equal(await fs.readFile(t.queuePath, "utf8"), before);
    });
  });

  it("clean install (no duplicate session ids): touches nothing, sets sentinel", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-droidclean-"));
    const root = path.join(home, "sessions");
    const queuePath = path.join(home, "queue.jsonl");
    const queueStatePath = path.join(home, "queue.state.json");
    const mt = Date.UTC(2026, 4, 21, 14, 5, 0);
    writeSettings(root, "proj", "solo", MODEL_DUP, 1_000_000, mt);
    const hour = toUtcHalfHourStart(new Date(mt).toISOString());
    await fs.writeFile(queuePath, droidRow(MODEL_DUP, hour, 1_000_000) + "\n", "utf8");
    const before = await fs.readFile(queuePath, "utf8");
    const cursors = { hourly: { buckets: {}, groupQueued: {} }, migrations: {} };

    const ret = await withDroidEnv(root, () =>
      repairDroidDuplicateSessionInflation({ cursors, queuePath, queueStatePath }),
    );
    assert.equal(ret, false);
    assert.ok(cursors.migrations[DROID_DUP_SESSION_REPAIR_KEY], "sentinel written");
    assert.equal(await fs.readFile(queuePath, "utf8"), before, "queue untouched");
  });
});
