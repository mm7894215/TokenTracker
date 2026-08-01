const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");
// child_process is used only for sqlite3 write fixtures; route them through
// in-process node:sqlite (see helpers/sqlite-write) to avoid per-statement spawns.
const { sqliteOnlyCp: cp } = require("./helpers/sqlite-write");

const {
  resolveWorkbuddyProjectFiles,
  parseWorkbuddyIncremental,
} = require("../src/lib/rollout");

// PR #399 Blocker #2: WorkBuddy fresh-install double count. A session with
// BOTH a trace file and a jsonl log was counted twice because the trace
// branch never recorded trace.sessionId into a tracedSessionIds set (the
// CodeBuddy equivalent existed). These tests pin the mirrored mechanism:
// restore, add-after-gates in the trace branch, suppression in BOTH the jsonl
// branch and the sqlite fallback, and capped persistence.

function traceJson({ traceId, sessionId, startedAt, totalTokens, miInput, miOutput, miCached, model }) {
  return {
    trace: {
      traceId: traceId ?? "trace_test_001",
      name: "Agent workflow",
      startedAt: startedAt ?? "2026-07-31T00:00:00.000Z",
      endedAt: "2026-07-31T00:01:00.000Z",
      status: "ok",
      totalTokens: totalTokens ?? 10000,
      sessionId: sessionId ?? "sess-both-001",
      modelInfo: {
        models: [model ?? "glm-5.2"],
        totalInputTokens: miInput ?? 9000,
        totalOutputTokens: miOutput ?? 1000,
        totalCachedTokens: miCached ?? 5000,
      },
    },
    spans: [],
  };
}

function jsonlLine({ id, ts, sessionId, promptTokens, completionTokens, model }) {
  const pt = promptTokens ?? 20000;
  const ct = completionTokens ?? 500;
  return JSON.stringify({
    id: id ?? "m1",
    timestamp: ts ?? 1753900800000,
    sessionId: sessionId ?? "sess-both-001",
    providerData: {
      model: model ?? "glm-5.2",
      rawUsage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    },
  });
}

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-wb-traces-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, WORKBUDDY_HOME: process.env.WORKBUDDY_HOME };
  const wbHome = path.join(home, ".workbuddy");
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.WORKBUDDY_HOME = wbHome;
    return await fn(home, wbHome);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.WORKBUDDY_HOME === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = saved.WORKBUDDY_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function queueTotal(queuePath, source) {
  let raw = "";
  try { raw = await fs.readFile(queuePath, "utf8"); } catch { return 0; }
  let sum = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.source === source) sum += row.total_tokens;
  }
  return sum;
}

test("parseWorkbuddyIncremental: session with BOTH trace and jsonl is counted once (trace wins)", async () => {
  await withTempHome(async (home, wbHome) => {
    await fs.mkdir(path.join(wbHome, "traces", "12345"), { recursive: true });
    await fs.mkdir(path.join(wbHome, "projects", "cwd-1"), { recursive: true });
    await fs.writeFile(
      path.join(wbHome, "traces", "12345", "trace_both.json"),
      JSON.stringify(traceJson({ traceId: "trace_both_001" })),
    );
    await fs.writeFile(
      path.join(wbHome, "projects", "cwd-1", "sess-both-001.jsonl"),
      jsonlLine({}) + "\n",
    );

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    const files = resolveWorkbuddyProjectFiles(process.env);
    await parseWorkbuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });

    // trace contributes 9000-5000+1000+5000 = 10000; jsonl would add 20500.
    // Double-counted would be 30500.
    assert.equal(await queueTotal(queuePath, "workbuddy"), 10000);
    assert.ok(
      Array.isArray(cursors.workbuddy.tracedSessionIds) &&
        cursors.workbuddy.tracedSessionIds.includes("sess-both-001"),
      "tracedSessionIds must persist the trace-covered session",
    );

    // Idempotency: a second run on the same fixture aggregates nothing.
    const second = await parseWorkbuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(await queueTotal(queuePath, "workbuddy"), 10000);
  });
});

test("parseWorkbuddyIncremental: trace-covered session is also skipped by the sqlite fallback", async () => {
  await withTempHome(async (home, wbHome) => {
    await fs.mkdir(path.join(wbHome, "traces", "12345"), { recursive: true });
    await fs.writeFile(
      path.join(wbHome, "traces", "12345", "trace_both.json"),
      JSON.stringify(traceJson({ traceId: "trace_both_001" })),
    );
    // sqlite has cumulative usage for the SAME session. Without the
    // tracedSessionIds guard in the sqlite loop, suppressing the jsonl branch
    // would just shift the double count to trace+sqlite.
    const dbPath = path.join(wbHome, "workbuddy.db");
    cp.execFileSync("sqlite3", [
      dbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT);",
        "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
        "INSERT INTO sessions VALUES ('sess-both-001','/tmp/project','auto');",
        "INSERT INTO session_usage VALUES ('sess-both-001',7777,0,1780000000000,'{}');",
      ].join(" "),
    ]);

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseWorkbuddyIncremental({
      projectFiles: resolveWorkbuddyProjectFiles(process.env),
      cursors,
      queuePath,
      env: process.env,
    });
    assert.equal(await queueTotal(queuePath, "workbuddy"), 10000);
  });
});

test("parseWorkbuddyIncremental: jsonl-only and trace-only sessions are both still counted", async () => {
  await withTempHome(async (home, wbHome) => {
    await fs.mkdir(path.join(wbHome, "traces", "1"), { recursive: true });
    await fs.mkdir(path.join(wbHome, "projects", "cwd-1"), { recursive: true });
    await fs.writeFile(
      path.join(wbHome, "traces", "1", "trace_only.json"),
      JSON.stringify(traceJson({ traceId: "trace_only_001", sessionId: "sess-trace-only" })),
    );
    await fs.writeFile(
      path.join(wbHome, "projects", "cwd-1", "sess-jsonl-only.jsonl"),
      jsonlLine({ id: "m-j", sessionId: "sess-jsonl-only", promptTokens: 2000, completionTokens: 100 }) + "\n",
    );

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseWorkbuddyIncremental({
      projectFiles: resolveWorkbuddyProjectFiles(process.env),
      cursors,
      queuePath,
      env: process.env,
    });
    // 10000 (trace) + 2100 (jsonl) — independent sessions, no suppression.
    assert.equal(await queueTotal(queuePath, "workbuddy"), 12100);
  });
});

test("parseWorkbuddyIncremental: zero-token trace does NOT suppress its session's jsonl", async () => {
  await withTempHome(async (home, wbHome) => {
    await fs.mkdir(path.join(wbHome, "traces", "9"), { recursive: true });
    await fs.mkdir(path.join(wbHome, "projects", "c"), { recursive: true });
    // A trace carrying no usage records only seenTraceIds — the jsonl branch
    // must remain authoritative for the session. This pins the placement of
    // tracedSessionIds.add AFTER all usage gates in the trace branch.
    await fs.writeFile(
      path.join(wbHome, "traces", "9", "trace_z.json"),
      JSON.stringify(traceJson({ traceId: "trace_zero", sessionId: "sess-z", totalTokens: 0, miInput: 0, miOutput: 0, miCached: 0 })),
    );
    await fs.writeFile(
      path.join(wbHome, "projects", "c", "sess-z.jsonl"),
      jsonlLine({ id: "m-z", sessionId: "sess-z", promptTokens: 700, completionTokens: 100 }) + "\n",
    );

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseWorkbuddyIncremental({
      projectFiles: resolveWorkbuddyProjectFiles(process.env),
      cursors,
      queuePath,
      env: process.env,
    });
    assert.equal(await queueTotal(queuePath, "workbuddy"), 800);
    assert.ok(!cursors.workbuddy.tracedSessionIds.includes("sess-z"));
  });
});
