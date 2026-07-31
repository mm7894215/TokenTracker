const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  resolveCodebuddyProjectFiles,
  parseCodebuddyIncremental,
} = require("../src/lib/rollout");
const {
  repairCodebuddyTraceJsonlOverlap,
  CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY,
} = require("../src/commands/sync");

// PR #399 Blocker #1: pre-tracedSessionIds CodeBuddy versions aggregated
// jsonl tokens into hourly buckets even for sessions that also had a trace
// file. tracedSessionIds is forward-only (suppresses jsonl parsed after the
// trace within one run) and buckets carry no session dimension, so the stale
// jsonl contribution could only be rolled back by a guarded rebuild. These
// tests pin the one-time repair: sentinel semantics, the reproducibility
// guard, the atomic rebuild + queue strip + zero retractions + upload offset
// reset, and no-op convergence afterwards.

const HALF_HOUR = "2026-07-31T00:00:00.000Z";
const TS_MS = Date.parse("2026-07-31T00:15:00.000Z"); // inside the …00:00 half-hour bucket

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cb-repair-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEBUDDY_HOME: process.env.CODEBUDDY_HOME, TOKENTRACKER_CODEBUDDY_LOG_FALLBACK: process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEBUDDY_HOME = path.join(home, ".codebuddy");
    delete process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK;
    return await fn(home, process.env.CODEBUDDY_HOME);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.CODEBUDDY_HOME === undefined) delete process.env.CODEBUDDY_HOME;
    else process.env.CODEBUDDY_HOME = saved.CODEBUDDY_HOME;
    if (saved.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK === undefined) delete process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK;
    else process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK = saved.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function jsonlLine({ id, ts, sessionId, promptTokens, completionTokens, cachedTokens }) {
  const pt = promptTokens ?? 20000;
  const ct = completionTokens ?? 500;
  return JSON.stringify({
    id: id ?? "r1",
    timestamp: ts ?? TS_MS,
    type: "message",
    role: "assistant",
    sessionId: sessionId ?? "sess-rep-001",
    providerData: {
      model: "glm-5.2",
      rawUsage: {
        prompt_tokens: pt,
        completion_tokens: ct,
        total_tokens: pt + ct,
        prompt_tokens_details: { cached_tokens: cachedTokens ?? 0, reasoning_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
}

function traceJson({ traceId, sessionId, startedAt }) {
  return {
    trace: {
      traceId: traceId ?? "tr1",
      sessionId: sessionId ?? "sess-rep-001",
      startedAt: startedAt ?? HALF_HOUR,
      endedAt: "2026-07-31T00:01:00.000Z",
      status: "ok",
      totalTokens: 10000,
      modelInfo: { models: ["glm-5.2"], totalInputTokens: 9000, totalOutputTokens: 1000, totalCachedTokens: 5000 },
    },
    spans: [],
  };
}

function codebuddyBucketTotals(cursors) {
  return Object.keys(cursors.hourly?.buckets || {})
    .filter((k) => k.startsWith("codebuddy|"))
    .sort()
    .map((k) => ({ key: k, total: cursors.hourly.buckets[k].totals.total_tokens }));
}

async function queueRows(queuePath) {
  let raw = "";
  try { raw = await fs.readFile(queuePath, "utf8"); } catch { return []; }
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("repairCodebuddyTraceJsonlOverlap: upgrade regression — legacy jsonl bucket is rebuilt to the trace-only value", async () => {
  await withTempHome(async (home, cbHome) => {
    const sid = "sess-rep-001";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, jsonlLine({ sessionId: sid }) + "\n");

    // Simulate the LEGACY write path: jsonl-only parse (no traces on disk
    // yet), then drop tracedSessionIds so the cursor looks pre-upgrade.
    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    const queueStatePath = path.join(home, "queue.state.json");
    await parseCodebuddyIncremental({ projectFiles: [{ path: jsonlPath, kind: "jsonl" }], cursors, queuePath, env: process.env });
    let buckets = codebuddyBucketTotals(cursors);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].total, 20500);
    delete cursors.codebuddy.tracedSessionIds;
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999, updatedAt: "old" }));

    // The trace file appears (upgrade). Without the repair, the next parse
    // would stack 10000 onto the stale 20500 bucket.
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "traces", "1", "trace_r.json"), JSON.stringify(traceJson({ sessionId: sid })));
    const allFiles = resolveCodebuddyProjectFiles(process.env);

    const ran = await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath, codebuddyFiles: allFiles, env: process.env });
    assert.equal(ran, true);

    buckets = codebuddyBucketTotals(cursors);
    assert.deepEqual(buckets.map((b) => b.total), [10000], "bucket rebuilt to the trace-only value");

    // queue.jsonl: only the rebuilt codebuddy rows remain (no stale 20500).
    const rows = await queueRows(queuePath);
    const cbTotal = rows.filter((r) => r.source === "codebuddy").reduce((s, r) => s + r.total_tokens, 0);
    assert.equal(cbTotal, 10000);

    // Upload offset reset so the corrected queue overwrites the cloud.
    const upState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    assert.equal(upState.offset, 0);
    assert.equal(upState.note, "reset_after_codebuddy_trace_overlap_2026_08");

    // Completed sentinel is a final ISO string.
    assert.ok(typeof cursors.migrations[CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY] === "string");

    // The regular parse later in the same sync is a natural no-op (rebuilt
    // fileOffsets sit at EOF) and cannot re-inflate.
    const after = await parseCodebuddyIncremental({ projectFiles: allFiles, cursors, queuePath, env: process.env });
    assert.equal(after.eventsAggregated, 0);
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [10000]);
  });
});

test("repairCodebuddyTraceJsonlOverlap: idempotent — completed sentinel short-circuits the second run", async () => {
  await withTempHome(async (home, cbHome) => {
    const sid = "sess-rep-001";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, jsonlLine({ sessionId: sid }) + "\n");
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "traces", "1", "trace_r.json"), JSON.stringify(traceJson({ sessionId: sid })));

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: [{ path: jsonlPath, kind: "jsonl" }], cursors, queuePath, env: process.env });
    delete cursors.codebuddy.tracedSessionIds;

    const allFiles = resolveCodebuddyProjectFiles(process.env);
    assert.equal(await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath: null, codebuddyFiles: allFiles, env: process.env }), true);
    const before = JSON.stringify(cursors.hourly.buckets);
    assert.equal(await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath: null, codebuddyFiles: allFiles, env: process.env }), false);
    assert.equal(JSON.stringify(cursors.hourly.buckets), before, "second run must not touch buckets");
  });
});

test("repairCodebuddyTraceJsonlOverlap: forward behavior — post-repair jsonl appends stay suppressed by tracedSessionIds", async () => {
  await withTempHome(async (home, cbHome) => {
    const sid = "sess-rep-001";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, jsonlLine({ sessionId: sid }) + "\n");
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "traces", "1", "trace_r.json"), JSON.stringify(traceJson({ sessionId: sid })));

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: [{ path: jsonlPath, kind: "jsonl" }], cursors, queuePath, env: process.env });
    delete cursors.codebuddy.tracedSessionIds;
    const allFiles = resolveCodebuddyProjectFiles(process.env);
    await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath: null, codebuddyFiles: allFiles, env: process.env });
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [10000]);

    // New assistant message appended to the traced session's jsonl AFTER the
    // repair must be skipped (tracedSessionIds covers the session).
    await fs.appendFile(jsonlPath, jsonlLine({ id: "r2", sessionId: sid, promptTokens: 4000, completionTokens: 100 }) + "\n");
    const again = await parseCodebuddyIncremental({ projectFiles: resolveCodebuddyProjectFiles(process.env), cursors, queuePath, env: process.env });
    assert.equal(again.eventsAggregated, 0);
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [10000]);
  });
});

test("repairCodebuddyTraceJsonlOverlap: guard — a deleted contributing file defers with a retryable skipped sentinel", async () => {
  await withTempHome(async (home, cbHome) => {
    const gonePath = path.join(cbHome, "projects", "p", "gone.jsonl");
    const liveKey = `codebuddy|glm-5.2|${HALF_HOUR}`;
    const cursors = {
      version: 1,
      migrations: {},
      hourly: { buckets: { [liveKey]: { totals: { total_tokens: 20500 } } }, groupQueued: {} },
      codebuddy: { fileOffsets: { [gonePath]: { size: 100, mtimeMs: 1, ino: 1 } } },
    };
    const ran = await repairCodebuddyTraceJsonlOverlap({
      cursors,
      queuePath: path.join(home, "queue.jsonl"),
      queueStatePath: null,
      codebuddyFiles: [],
      env: process.env,
    });
    assert.equal(ran, false);
    const sentinel = cursors.migrations[CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY];
    assert.equal(sentinel.skipped, true);
    assert.equal(sentinel.reason, "codebuddy_file_unreproducible");
    // Live history untouched.
    assert.equal(cursors.hourly.buckets[liveKey].totals.total_tokens, 20500);
  });
});

test("repairCodebuddyTraceJsonlOverlap: fast path — no codebuddy buckets finalizes in O(1)", async () => {
  await withTempHome(async (home) => {
    const cursors = { version: 1, migrations: {}, hourly: { buckets: {}, groupQueued: {} } };
    const ran = await repairCodebuddyTraceJsonlOverlap({
      cursors,
      queuePath: path.join(home, "queue.jsonl"),
      queueStatePath: null,
      codebuddyFiles: [],
      env: process.env,
    });
    assert.equal(ran, false);
    assert.ok(typeof cursors.migrations[CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY] === "string");
    assert.deepEqual(cursors.hourly.buckets, {});
  });
});

test("repairCodebuddyTraceJsonlOverlap: adjacent-bucket case — stale jsonl key gets a zero retraction, trace key is rebuilt", async () => {
  await withTempHome(async (home, cbHome) => {
    const sid = "sess-rep-adj";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    // jsonl message at 00:15 (bucket …00:00), trace startedAt 00:45 (bucket
    // …00:30) — the repair must redistribute across adjacent half-hours.
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, jsonlLine({ sessionId: sid, ts: TS_MS }) + "\n");
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(
      path.join(cbHome, "traces", "1", "trace_adj.json"),
      JSON.stringify(traceJson({ traceId: "tr-adj", sessionId: sid, startedAt: "2026-07-31T00:45:00.000Z" })),
    );

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: [{ path: jsonlPath, kind: "jsonl" }], cursors, queuePath, env: process.env });
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [20500]);
    delete cursors.codebuddy.tracedSessionIds;

    const allFiles = resolveCodebuddyProjectFiles(process.env);
    await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath: null, codebuddyFiles: allFiles, env: process.env });

    const buckets = codebuddyBucketTotals(cursors);
    assert.equal(buckets.length, 1);
    assert.ok(buckets[0].key.endsWith("|2026-07-31T00:30:00.000Z"), "only the trace bucket survives");
    assert.equal(buckets[0].total, 10000);

    // The stale …00:00 jsonl key was deleted locally — the queue must carry a
    // zero retraction for it so the cloud overwrite-upsert clears it too.
    const rows = await queueRows(queuePath);
    const zeroRetractions = rows.filter(
      (r) => r.source === "codebuddy" && r.total_tokens === 0 && r.hour_start === "2026-07-31T00:00:00.000Z",
    );
    assert.equal(zeroRetractions.length, 1, "stale jsonl bucket must be retracted with a zero row");
    const rebuiltRows = rows.filter((r) => r.source === "codebuddy" && r.total_tokens > 0);
    assert.equal(rebuiltRows.reduce((s, r) => s + r.total_tokens, 0), 10000);
  });
});

test("repairCodebuddyTraceJsonlOverlap: jsonl-only history rebuilds deterministically (no churn without traces)", async () => {
  await withTempHome(async (home, cbHome) => {
    const sid = "sess-plain";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, jsonlLine({ sessionId: sid }) + "\n");

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: [{ path: jsonlPath, kind: "jsonl" }], cursors, queuePath, env: process.env });
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [20500]);
    delete cursors.codebuddy.tracedSessionIds;

    // No traces directory at all — the rebuild must reproduce the same total.
    const allFiles = resolveCodebuddyProjectFiles(process.env);
    const ran = await repairCodebuddyTraceJsonlOverlap({ cursors, queuePath, queueStatePath: null, codebuddyFiles: allFiles, env: process.env });
    assert.equal(ran, true);
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [20500], "jsonl-only history is reproduced unchanged");
  });
});
