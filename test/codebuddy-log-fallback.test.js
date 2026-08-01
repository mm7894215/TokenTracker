const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  resolveCodebuddyProjectFiles,
  detectCodebuddyLogFallback,
  parseCodebuddyIncremental,
} = require("../src/lib/rollout");

// PR #399 Blocker #3: pre-2026-04 CodeBuddy has neither ~/.codebuddy/traces/
// nor rawUsage/usage on jsonl assistant messages, so the only usage source is
// the IDE extension log's [AgentReporter] lines. The old hard env gate
// (TOKENTRACKER_CODEBUDDY_LOG_FALLBACK=1, default off) silently zeroed these
// users. The gate is now three-state: =1 force-on, =0 force-off, unset =
// auto (off when traces exist or any jsonl carries usage; on only when
// neither does — the one situation where logs cannot double-count).

const ENV_KEYS = [
  "HOME", "USERPROFILE", "CODEBUDDY_HOME",
  "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "TOKENTRACKER_CODEBUDDY_LOG_FALLBACK",
];

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cb-logfb-"));
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEBUDDY_HOME = path.join(home, ".codebuddy");
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    delete process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK;
    return await fn(home, process.env.CODEBUDDY_HOME);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

// Write an extension log (one Model prepared + two usage lines) into the
// platform-appropriate log root that resolveCodebuddyProjectFiles scans.
async function writeExtensionLog(home) {
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
}

// Legacy jsonl: assistant message whose providerData carries ONLY the model —
// no rawUsage, no top-level usage (pre-2026-04 shape, always dropped by the
// jsonl branch).
function legacyJsonlLine() {
  return JSON.stringify({
    id: "x1",
    timestamp: 1753900800000,
    type: "message",
    role: "assistant",
    sessionId: "sess-old",
    providerData: { model: "glm-4" },
  });
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

test("codebuddy log fallback: legacy install (no traces, jsonl without usage) auto-enables extension logs", async () => {
  await withTempHome(async (home, cbHome) => {
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "projects", "p", "sess-old.jsonl"), legacyJsonlLine() + "\n");
    await writeExtensionLog(home);

    const files = resolveCodebuddyProjectFiles(process.env);
    assert.ok(files.some((f) => f.kind === "log"), "auto mode must include extension logs for legacy installs");

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });
    assert.equal(await queueTotal(queuePath, "codebuddy"), 9000); // 3400 + 5600
    assert.equal(cursors.codebuddy.logFallback.mode, "auto-on");
    assert.equal(cursors.codebuddy.logFallback.reason, "no_traces_no_jsonl_usage");
  });
});

test("codebuddy log fallback: traces present → auto-off (no 3x inflation regression)", async () => {
  await withTempHome(async (home, cbHome) => {
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "projects", "p", "sess-old.jsonl"), legacyJsonlLine() + "\n");
    await fs.mkdir(path.join(cbHome, "traces", "1"), { recursive: true });
    await fs.writeFile(
      path.join(cbHome, "traces", "1", "trace_a.json"),
      JSON.stringify({
        trace: {
          traceId: "ta",
          sessionId: "sess-old",
          startedAt: "2026-07-31T00:00:00.000Z",
          totalTokens: 100,
          modelInfo: { models: ["glm-5.2"], totalInputTokens: 80, totalOutputTokens: 20, totalCachedTokens: 0 },
        },
        spans: [],
      }),
    );
    await writeExtensionLog(home);

    const files = resolveCodebuddyProjectFiles(process.env);
    assert.ok(!files.some((f) => f.kind === "log"), "traces are authoritative — logs must stay off");

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });
    assert.equal(await queueTotal(queuePath, "codebuddy"), 100); // trace only
    assert.equal(cursors.codebuddy.logFallback.mode, "auto-off");
    assert.equal(cursors.codebuddy.logFallback.reason, "traces_present");
  });
});

test("codebuddy log fallback: jsonl carrying usage → auto-off (sniff)", async () => {
  await withTempHome(async (home, cbHome) => {
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    await fs.writeFile(
      path.join(cbHome, "projects", "p", "s.jsonl"),
      JSON.stringify({
        id: "u1",
        timestamp: 1753900800000,
        type: "message",
        role: "assistant",
        sessionId: "s",
        providerData: { model: "glm-5.2", rawUsage: { prompt_tokens: 100, completion_tokens: 10 } },
      }) + "\n",
    );
    await writeExtensionLog(home);

    const files = resolveCodebuddyProjectFiles(process.env);
    assert.ok(!files.some((f) => f.kind === "log"), "jsonl with usage → logs must stay off");

    const cursors = { version: 1 };
    const queuePath = path.join(home, "queue.jsonl");
    await parseCodebuddyIncremental({ projectFiles: files, cursors, queuePath, env: process.env });
    assert.equal(await queueTotal(queuePath, "codebuddy"), 110); // jsonl only
    assert.equal(cursors.codebuddy.logFallback.mode, "auto-off");
    assert.equal(cursors.codebuddy.logFallback.reason, "jsonl_usage_present");
  });
});

test("codebuddy log fallback: env overrides — =0 forces off, =1 forces on", async () => {
  await withTempHome(async (home, cbHome) => {
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "projects", "p", "sess-old.jsonl"), legacyJsonlLine() + "\n");
    await writeExtensionLog(home);

    process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK = "0";
    const offFiles = resolveCodebuddyProjectFiles(process.env);
    assert.ok(!offFiles.some((f) => f.kind === "log"));
    const cursorsOff = { version: 1 };
    const queueOff = path.join(home, "queue-off.jsonl");
    await parseCodebuddyIncremental({ projectFiles: offFiles, cursors: cursorsOff, queuePath: queueOff, env: process.env });
    assert.equal(await queueTotal(queueOff, "codebuddy"), 0);
    assert.equal(cursorsOff.codebuddy.logFallback.mode, "force-off");

    process.env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK = "1";
    const onFiles = resolveCodebuddyProjectFiles(process.env);
    assert.ok(onFiles.some((f) => f.kind === "log"));
    const cursorsOn = { version: 1 };
    const queueOn = path.join(home, "queue-on.jsonl");
    await parseCodebuddyIncremental({ projectFiles: onFiles, cursors: cursorsOn, queuePath: queueOn, env: process.env });
    assert.equal(await queueTotal(queueOn, "codebuddy"), 9000);
    assert.equal(cursorsOn.codebuddy.logFallback.mode, "force-on");
  });
});

test("codebuddy log fallback: sniff is robust — empty and corrupt-head jsonl do not crash or falsely enable", async () => {
  await withTempHome(async (home, cbHome) => {
    await fs.mkdir(path.join(cbHome, "projects", "p"), { recursive: true });
    await fs.writeFile(path.join(cbHome, "projects", "p", "empty.jsonl"), "");
    await fs.writeFile(path.join(cbHome, "projects", "p", "corrupt.jsonl"), "{not json\n\"usage\" also not json\n");
    // detectCodebuddyLogFallback is pure detection; with no usage anywhere it
    // must return auto-on (logs are the only source) without throwing.
    const files = [
      { path: path.join(cbHome, "projects", "p", "empty.jsonl"), kind: "jsonl" },
      { path: path.join(cbHome, "projects", "p", "corrupt.jsonl"), kind: "jsonl" },
    ];
    const info = detectCodebuddyLogFallback(process.env, files);
    assert.equal(info.mode, "auto-on");
    assert.equal(info.jsonlFiles, 2);
  });
});
