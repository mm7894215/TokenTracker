const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  resolveCodebuddyProjectFiles,
  parseCodebuddyIncremental,
} = require("../src/lib/rollout");

// Trace JSON fixture: a single finalized trace with modelInfo breakdown.
function traceJson({ traceId, sessionId, startedAt, totalTokens, miInput, miOutput, miCached, model }) {
  return {
    trace: {
      traceId: traceId || "trace_test_001",
      name: "Agent workflow",
      workerPid: 12345,
      workerHostname: "test",
      startedAt: startedAt || "2026-07-31T00:00:00.000Z",
      endedAt: "2026-07-31T00:01:00.000Z",
      duration: 60000,
      status: "ok",
      spanCount: 6,
      totalTokens: totalTokens || 1208838,
      sessionId: sessionId || "sess-001",
      agentName: "cli",
      modelInfo: {
        models: [model || "glm-5.2"],
        totalInputTokens: miInput || 1206233,
        totalOutputTokens: miOutput || 2605,
        totalCachedTokens: miCached || 1196800,
        lastCallInputTokens: 1206233,
        callCount: 6,
      },
    },
    spans: [],
  };
}

// JSONL fixture: a single assistant message with providerData.rawUsage.
function jsonlLine({ ts, uuid, sessionId, promptTokens, completionTokens, cachedTokens, reasoningTokens, model }) {
  return JSON.stringify({
    id: uuid || "msg-001",
    timestamp: ts || 1753900800000,
    type: "message",
    role: "assistant",
    sessionId: sessionId || "sess-001",
    content: [{ type: "output_text", text: "..." }],
    providerData: {
      model: model || "glm-5.2",
      rawUsage: {
        prompt_tokens: promptTokens || 71161,
        completion_tokens: completionTokens || 2305,
        total_tokens: (promptTokens || 71161) + (completionTokens || 2305),
        prompt_tokens_details: { cached_tokens: cachedTokens || 62656, reasoning_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: reasoningTokens || 999 },
      },
    },
  });
}

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cb-traces-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEBUDDY_HOME: process.env.CODEBUDDY_HOME,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return await fn(home);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.CODEX_HOME === undefined) delete process.env.CODEBUDDY_HOME;
    else process.env.CODEBUDDY_HOME = saved.CODEBUDDY_HOME;
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

test("resolveCodebuddyProjectFiles discovers trace_*.json under traces/<pid>/", async () => {
  await withTempHome(async (home) => {
    const codebuddyHome = path.join(home, ".codebuddy");
    const tracesDir = path.join(codebuddyHome, "traces", "12345");
    await fs.mkdir(tracesDir, { recursive: true });
    await fs.writeFile(
      path.join(tracesDir, "trace_abc.json"),
      JSON.stringify(traceJson({})),
    );
    // Also create a non-trace json to ensure it's skipped.
    await fs.writeFile(path.join(tracesDir, "other.json"), "{}");

    const files = resolveCodebuddyProjectFiles({ CODEBUDDY_HOME: codebuddyHome });
    const traceFiles = files.filter((f) => typeof f === "object" && f.kind === "trace");
    assert.equal(traceFiles.length, 1, "exactly one trace file");
    assert.ok(traceFiles[0].path.endsWith("trace_abc.json"));
  });
});

test("parseCodebuddyIncremental: trace is counted once, second run is idempotent", async () => {
  await withTempHome(async (home) => {
    const codebuddyHome = path.join(home, ".codebuddy");
    const tracesDir = path.join(codebuddyHome, "traces", "12345");
    await fs.mkdir(tracesDir, { recursive: true });
    const tracePath = path.join(tracesDir, "trace_abc.json");
    await fs.writeFile(tracePath, JSON.stringify(traceJson({ traceId: "trace_dup_001" })));

    const queuePath = path.join(home, "queue.jsonl");
    const cursors = { codebuddy: {}, hourly: { version: 1, buckets: {}, groupQueued: {} } };

    // First parse.
    const r1 = await parseCodebuddyIncremental({
      cursors,
      queuePath,
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: home, USERPROFILE: home },
    });
    assert.ok(r1.eventsAggregated > 0, "first run aggregates events");

    // Second parse — should be idempotent (traceId dedup).
    const r2 = await parseCodebuddyIncremental({
      cursors,
      queuePath,
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: home, USERPROFILE: home },
    });
    assert.equal(r2.eventsAggregated, 0, "second run adds nothing (traceId dedup)");
  });
});

test("parseCodebuddyIncremental: session with BOTH trace and jsonl is counted once (no double-count)", async () => {
  await withTempHome(async (home) => {
    const codebuddyHome = path.join(home, ".codebuddy");
    const tracesDir = path.join(codebuddyHome, "traces", "12345");
    const projectsDir = path.join(codebuddyHome, "projects", "cwd-1");
    await fs.mkdir(tracesDir, { recursive: true });
    await fs.mkdir(projectsDir, { recursive: true });

    const sessionId = "sess-both-001";
    // Trace: totalTokens = 10000
    await fs.writeFile(
      path.join(tracesDir, "trace_both.json"),
      JSON.stringify(traceJson({
        traceId: "trace_both_001",
        sessionId,
        totalTokens: 10000,
        miInput: 9000,
        miOutput: 1000,
        miCached: 5000,
      })),
    );
    // JSONL: same sessionId, rawUsage with prompt_tokens=20000
    await fs.writeFile(
      path.join(projectsDir, `${sessionId}.jsonl`),
      jsonlLine({ sessionId, promptTokens: 20000, completionTokens: 500, cachedTokens: 0 }) + "\n",
    );

    const queuePath = path.join(home, "queue.jsonl");
    const cursors = { codebuddy: {}, hourly: { version: 1, buckets: {}, groupQueued: {} } };

    await parseCodebuddyIncremental({
      cursors,
      queuePath,
      env: { CODEBUDDY_HOME: codebuddyHome, HOME: home, USERPROFILE: home },
    });

    // Read queue — the jsonl message should have been skipped (tracedSessionIds).
    const queueContent = await fs.readFile(queuePath, "utf8").catch(() => "");
    const records = queueContent.trim() ? queueContent.trim().split("\n").map((l) => JSON.parse(l)) : [];
    // Trace contributes 10000 total (miInput + miOutput = 9000 + 1000).
    // JSONL contributes 0 (skipped by tracedSessionIds).
    // If double-counted, total would be 10000 + 20500 = 30500.
    const totalTokens = records.reduce((s, r) => s + (r.total_tokens || 0), 0);
    assert.equal(totalTokens, 10000, "trace + jsonl same session = counted once (trace wins)");
  });
});
