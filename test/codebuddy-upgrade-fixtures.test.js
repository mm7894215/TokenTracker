const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  resolveCodebuddyProjectFiles,
  parseCodebuddyIncremental,
  resolveWorkbuddyProjectFiles,
  parseWorkbuddyIncremental,
} = require("../src/lib/rollout");
const {
  repairCodebuddyTraceJsonlOverlap,
  CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY,
} = require("../src/commands/sync");

// PR #399 upgrade-fixture regression suite. One test per blocker, each
// replaying the exact upgrade scenario that motivated the fix:
//   a. Blocker #1 — pre-tracedSessionIds cursors already hold jsonl-only
//      buckets; after upgrade the trace for the same session appears. The
//      one-time repair must rebuild history to the trace-authoritative value.
//   b. Blocker #2 — WorkBuddy fresh install ingests a session's trace AND
//      jsonl in one run; tracedSessionIds must suppress the jsonl branch.
//   c. Blocker #3 — legacy CodeBuddy (no traces/, jsonl without rawUsage)
//      must auto-enable the extension-log fallback instead of going silent.

const ENV_KEYS = [
  "HOME", "USERPROFILE", "CODEBUDDY_HOME", "WORKBUDDY_HOME",
  "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "TOKENTRACKER_CODEBUDDY_LOG_FALLBACK",
];

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-upgrade-fix-"));
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    delete process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK;
    delete process.env.CODEBUDDY_HOME;
    delete process.env.WORKBUDDY_HOME;
    return await fn(home);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

// Both the jsonl message ts and the trace startedAt land inside the same
// half-hour bucket (…00:00) so the pre-fix double count hits one bucket.
const HALF_HOUR = "2026-07-31T00:00:00.000Z";
const TS_MS = Date.parse("2026-07-31T00:15:00.000Z");

function cbTraceJson({ traceId, sessionId, startedAt, totalTokens }) {
  return {
    trace: {
      traceId: traceId ?? "tr-upg-001",
      sessionId: sessionId ?? "sess-upg-001",
      startedAt: startedAt ?? HALF_HOUR,
      endedAt: "2026-07-31T00:01:00.000Z",
      status: "ok",
      totalTokens: totalTokens ?? 10000,
      modelInfo: { models: ["glm-5.2"], totalInputTokens: 9000, totalOutputTokens: 1000, totalCachedTokens: 5000 },
    },
    spans: [],
  };
}

// Modern CodeBuddy jsonl: assistant message carrying providerData.rawUsage.
function cbJsonlLine({ id, ts, sessionId, promptTokens, completionTokens }) {
  const pt = promptTokens ?? 20000;
  const ct = completionTokens ?? 500;
  return JSON.stringify({
    id: id ?? "m-upg-1",
    timestamp: ts ?? TS_MS,
    type: "message",
    role: "assistant",
    sessionId: sessionId ?? "sess-upg-001",
    providerData: {
      model: "glm-5.2",
      rawUsage: {
        prompt_tokens: pt,
        completion_tokens: ct,
        total_tokens: pt + ct,
        prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
}

function codebuddyBucketTotals(cursors) {
  return Object.keys(cursors.hourly?.buckets || {})
    .filter((k) => k.startsWith("codebuddy|"))
    .sort()
    .map((k) => ({ key: k, total: cursors.hourly.buckets[k].totals.total_tokens }));
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

test("Blocker #1 upgrade: legacy jsonl bucket 20500 is rebuilt to the trace-only 10000", async () => {
  await withTempHome(async (home) => {
    const cbHome = path.join(home, ".codebuddy");
    process.env.CODEBUDDY_HOME = cbHome;
    const sid = "sess-upg-001";
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    const jsonlPath = path.join(cbHome, "projects", "p", `${sid}.jsonl`);
    await fs.writeFile(jsonlPath, cbJsonlLine({ sessionId: sid }) + "\n");

    // Simulate the LEGACY (pre-tracedSessionIds) state: parse jsonl-only so
    // the 20500 bucket exists, then drop tracedSessionIds from the cursor.
    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({
      projectFiles: [{ path: jsonlPath, kind: "jsonl" }],
      cursors,
      queuePath,
      env: process.env,
    });
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [20500], "legacy bucket is 20500");
    delete cursors.codebuddy.tracedSessionIds;

    // Upgrade: the trace file for the SAME session appears on disk.
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(
      path.join(cbHome, "traces", "1", "trace_upg.json"),
      JSON.stringify(cbTraceJson({ sessionId: sid })),
    );

    // The one-time repair runs before the regular parse inside sync.
    const allFiles = resolveCodebuddyProjectFiles(process.env);
    const ran = await repairCodebuddyTraceJsonlOverlap({
      cursors,
      queuePath,
      queueStatePath: null,
      codebuddyFiles: allFiles,
      env: process.env,
    });
    assert.equal(ran, true, "repair must run on first post-upgrade sync");

    // Trace is authoritative: the stale jsonl contribution is rolled back,
    // NOT stacked (pre-fix would yield 30500).
    assert.deepEqual(
      codebuddyBucketTotals(cursors).map((b) => b.total),
      [10000],
      "bucket rebuilt to the trace-only value (trace wins over legacy jsonl)",
    );
    assert.equal(await queueTotal(queuePath, "codebuddy"), 10000, "queue holds no stale 20500 rows");
    assert.ok(
      typeof cursors.migrations[CODEBUDDY_TRACE_OVERLAP_REPAIR_KEY] === "string",
      "completion sentinel persisted",
    );

    // Same-sync regular parse converges: rebuilt fileOffsets sit at EOF.
    const after = await parseCodebuddyIncremental({ projectFiles: allFiles, cursors, queuePath, env: process.env });
    assert.equal(after.eventsAggregated, 0, "same-sync parse is a no-op after repair");
    assert.deepEqual(codebuddyBucketTotals(cursors).map((b) => b.total), [10000]);
  });
});

test("Blocker #2 upgrade: workbuddy session with BOTH trace and jsonl is counted once", async () => {
  await withTempHome(async (home) => {
    const wbHome = path.join(home, ".workbuddy");
    process.env.WORKBUDDY_HOME = wbHome;
    const sid = "sess-both-001";
    await fs.mkdir(path.join(wbHome, "traces", "12345"), { recursive: true });
    await fs.mkdir(path.join(wbHome, "projects", "cwd-1"), { recursive: true });

    // Trace: totalTokens = 10000 (9000 - 5000 cached + 1000 out + 5000 cached).
    await fs.writeFile(
      path.join(wbHome, "traces", "12345", "trace_both.json"),
      JSON.stringify({
        trace: {
          traceId: "trace_both_001",
          sessionId: sid,
          startedAt: HALF_HOUR,
          endedAt: "2026-07-31T00:01:00.000Z",
          status: "ok",
          totalTokens: 10000,
          modelInfo: { models: ["glm-5.2"], totalInputTokens: 9000, totalOutputTokens: 1000, totalCachedTokens: 5000 },
        },
        spans: [],
      }),
    );
    // Same session's jsonl: rawUsage prompt 20000 + completion 500 = 20500.
    await fs.writeFile(
      path.join(wbHome, "projects", "cwd-1", `${sid}.jsonl`),
      JSON.stringify({
        id: "m-wb-1",
        timestamp: TS_MS,
        sessionId: sid,
        providerData: {
          model: "glm-5.2",
          rawUsage: { prompt_tokens: 20000, completion_tokens: 500, total_tokens: 20500 },
        },
      }) + "\n",
    );

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseWorkbuddyIncremental({
      projectFiles: resolveWorkbuddyProjectFiles(process.env),
      cursors,
      queuePath,
      env: process.env,
    });

    // Double-counted would be 10000 + 20500 = 30500; trace must win.
    assert.equal(await queueTotal(queuePath, "workbuddy"), 10000, "trace + jsonl same session = counted once");
    assert.ok(
      Array.isArray(cursors.workbuddy.tracedSessionIds) && cursors.workbuddy.tracedSessionIds.includes(sid),
      "tracedSessionIds persists the trace-covered session",
    );
  });
});

test("Blocker #3 upgrade: legacy CodeBuddy (no traces, jsonl without rawUsage) collects via extension-log fallback", async () => {
  await withTempHome(async (home) => {
    const cbHome = path.join(home, ".codebuddy");
    process.env.CODEBUDDY_HOME = cbHome;
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    // Pre-2026-04 jsonl shape: providerData carries ONLY the model — no
    // rawUsage, no top-level usage — so the jsonl branch drops every line.
    await fs.writeFile(
      path.join(cbHome, "projects", "p", "sess-old.jsonl"),
      JSON.stringify({
        id: "x1",
        timestamp: TS_MS,
        type: "message",
        role: "assistant",
        sessionId: "sess-old",
        providerData: { model: "glm-4" },
      }) + "\n",
    );
    // No ~/.codebuddy/traces/ directory at all. The only usage source is the
    // IDE extension log under the platform log root.
    let logDir;
    if (process.platform === "darwin") {
      logDir = path.join(home, "Library", "Application Support", "Code", "logs", "tencent-cloud.coding-copilot");
    } else if (process.platform === "win32") {
      logDir = path.join(process.env.APPDATA, "Code", "logs", "tencent-cloud.coding-copilot");
    } else {
      logDir = path.join(process.env.XDG_CONFIG_HOME, "Code", "logs", "tencent-cloud.coding-copilot");
    }
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, "codebuddy-extension-log.log"),
      [
        "[2026/7/31 00:00:01.000] [info] [CraftInvokableAgent] [agent-1] Model prepared: GLM 5.2 (glm-5.2)",
        '[2026/7/31 00:00:02.000] [info] [AgentReporter] [agent-1] Agent execution successful with usage: {"inputTokens":3000,"outputTokens":400,"totalTokens":3400}',
        '[2026/7/31 00:00:03.000] [info] [AgentReporter] [agent-1] Agent execution successful with usage: {"inputTokens":5000,"outputTokens":600,"totalTokens":5600}',
      ].join("\n") + "\n",
    );

    // env unset → auto mode must turn the fallback ON for this legacy shape.
    const files = resolveCodebuddyProjectFiles(process.env);
    assert.ok(files.some((f) => f.kind === "log"), "auto mode includes extension logs for legacy installs");

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });
    assert.equal(await queueTotal(queuePath, "codebuddy"), 9000, "legacy install collects 3400 + 5600 from logs");
    assert.equal(cursors.codebuddy.logFallback.mode, "auto-on");
    assert.equal(cursors.codebuddy.logFallback.reason, "no_traces_no_jsonl_usage");
  });
});
