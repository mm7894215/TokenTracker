const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  cmdSync,
  isCodexColdScanAuditDue,
  scheduleAutoRetry,
} = require("../src/commands/sync");
const { listRolloutFiles } = require("../src/lib/rollout");

function tokenCountLine({ ts, last, total }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  });
}

async function writeCodexRollout(codexHome, date, uuid, totalTokens = 12) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  await fs.writeFile(
    filePath,
    tokenCountLine({ ts: `${date}T00:00:00.000Z`, last: usage, total: usage }) + "\n",
    "utf8",
  );
  return filePath;
}

async function writeArchivedCodexRollout(codexHome, date, uuid, totalTokens = 12) {
  const dir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  await fs.writeFile(
    filePath,
    tokenCountLine({ ts: `${date}T00:00:00.000Z`, last: usage, total: usage }) + "\n",
    "utf8",
  );
  return filePath;
}

async function writeNestedArchivedCodexRollout(codexHome, date, uuid, totalTokens = 12) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexHome, "archived_sessions", year, month, day, uuid);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  await fs.writeFile(
    filePath,
    tokenCountLine({ ts: `${date}T00:00:00.000Z`, last: usage, total: usage }) + "\n",
    "utf8",
  );
  return filePath;
}

async function withTempSyncEnv(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-source-scope-"));
  const saved = {
    HOME: process.env.HOME,
    // os.homedir() reads USERPROFILE on Windows, so isolate it too or the test
    // writes into the developer's real ~/.tokentracker.
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_OPENCLAW_AGENT_ID: process.env.TOKENTRACKER_OPENCLAW_AGENT_ID,
    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID,
    TOKENTRACKER_OPENCLAW_SESSION_KEY: process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY,
    TOKENTRACKER_OPENCLAW_HOME: process.env.TOKENTRACKER_OPENCLAW_HOME,
    TOKENTRACKER_INSFORGE_BASE_URL: process.env.TOKENTRACKER_INSFORGE_BASE_URL,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY;
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function countReaddir(fn, predicate = () => true) {
  const realReaddir = fs.readdir;
  let count = 0;
  fs.readdir = async function countedReaddir(target, ...args) {
    if (predicate(String(target))) count += 1;
    return realReaddir.call(this, target, ...args);
  };
  try {
    const value = await fn();
    return { count, value };
  } finally {
    fs.readdir = realReaddir;
  }
}

async function countStat(fn, predicate = () => true) {
  const realStat = fs.stat;
  let count = 0;
  fs.stat = async function countedStat(target, ...args) {
    if (predicate(String(target))) count += 1;
    return realStat.call(this, target, ...args);
  };
  try {
    const value = await fn();
    return { count, value };
  } finally {
    fs.stat = realStat;
  }
}

test("non-Codex notify auto sync does not enumerate Codex sessions or archives", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-1111-7222-8333-444444444444",
      42,
    );
    await fs.mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });

    const codexRoot = path.join(codexHome);
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--from-notify", "--source=gemini"]),
      (target) => target.startsWith(codexRoot),
    );

    assert.equal(count, 0, "gemini notify scope must not readdir ~/.codex/sessions or archived_sessions");
    await assert.rejects(
      fs.stat(path.join(home, ".tokentracker", "tracker", "queue.jsonl")),
      /ENOENT/,
    );
  });
});

test("unknown notify source falls back to full scan instead of skipping everything", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-2222-7333-8444-555555555555",
      17,
    );

    const sessionsRoot = path.join(codexHome, "sessions");
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--from-notify", "--source=unknown-provider"]),
      (target) => target.startsWith(sessionsRoot),
    );

    assert.ok(count > 0, "unknown source should degrade to a full scan");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":17/);
  });
});

test("source-scoped retry auto sync does not enumerate Codex sessions", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-3333-7444-8555-666666666666",
      19,
    );

    const codexRoot = path.join(codexHome);
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--from-retry", "--source=gemini"]),
      (target) => target.startsWith(codexRoot),
    );

    assert.equal(count, 0, "gemini retry scope must not readdir ~/.codex");
    await assert.rejects(
      fs.stat(path.join(home, ".tokentracker", "tracker", "queue.jsonl")),
      /ENOENT/,
    );
  });
});

test("legacy retry auto sync without source remains a full scan", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-4444-7555-8666-777777777777",
      23,
    );

    const sessionsRoot = path.join(codexHome, "sessions");
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--from-retry"]),
      (target) => target.startsWith(sessionsRoot),
    );

    assert.ok(count > 0, "retry without a source should preserve the legacy full scan");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":23/);
  });
});

test("OpenClaw auto sync does not enumerate Codex sessions", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-4545-7666-8777-888888888888",
      31,
    );

    const codexRoot = path.join(codexHome);
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--from-openclaw"]),
      (target) => target.startsWith(codexRoot),
    );

    assert.equal(count, 0, "OpenClaw lifecycle sync should only inspect OpenClaw state");
  });
});

test("auto retry refreshes stale source scope without rescheduling later retry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-auto-retry-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    const retryPath = path.join(trackerDir, "auto.retry.json");
    await fs.mkdir(trackerDir, { recursive: true });

    const laterRetryAtMs = Date.now() + 60_000;
    await fs.writeFile(
      retryPath,
      JSON.stringify({
        version: 1,
        retryAtMs: laterRetryAtMs,
        retryAt: new Date(laterRetryAtMs).toISOString(),
        reason: "backlog",
        pendingBytes: 5,
        scheduledAt: new Date().toISOString(),
        source: "auto-backlog",
      }),
      "utf8",
    );

    const scoped = await scheduleAutoRetry({
      trackerDir,
      retryAtMs: Date.now() + 30_000,
      reason: "backlog",
      pendingBytes: 11,
      source: "gemini-backlog",
      syncSource: "gemini",
      autoRetryNoSpawn: true,
    });

    assert.equal(scoped.scheduled, false);
    assert.equal(scoped.retryAtMs, laterRetryAtMs);
    const scopedPayload = JSON.parse(await fs.readFile(retryPath, "utf8"));
    assert.equal(scopedPayload.retryAtMs, laterRetryAtMs);
    assert.equal(scopedPayload.syncSource, "gemini");

    const full = await scheduleAutoRetry({
      trackerDir,
      retryAtMs: Date.now() + 30_000,
      reason: "backlog",
      pendingBytes: 13,
      source: "auto-backlog",
      syncSource: null,
      autoRetryNoSpawn: true,
    });

    assert.equal(full.scheduled, false);
    assert.equal(full.retryAtMs, laterRetryAtMs);
    const fullPayload = JSON.parse(await fs.readFile(retryPath, "utf8"));
    assert.equal(fullPayload.retryAtMs, laterRetryAtMs);
    assert.equal(Object.hasOwn(fullPayload, "syncSource"), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("non-Grok notify auto sync leaves pending Grok hook signal untouched", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const signalPath = path.join(trackerDir, "grok-last-session.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      signalPath,
      JSON.stringify({
        sessionId: "grok-session-1",
        totalTokens: 44,
        contextTokensUsed: 44,
        lastActive: "2026-06-30T00:00:00.000Z",
      }),
      "utf8",
    );

    await cmdSync(["--auto", "--from-notify", "--source=gemini"]);

    const signal = JSON.parse(await fs.readFile(signalPath, "utf8"));
    assert.equal(signal.sessionId, "grok-session-1");
  });
});

test("source-scoped notify sync does not run project purge reconciliation", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const projectQueueStatePath = path.join(trackerDir, "project.queue.state.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      cursorsPath,
      JSON.stringify({
        version: 1,
        files: {},
        projectHourly: {
          buckets: {
            "project-1|gemini|2026-06-30T00:00:00.000Z": {
              project_ref: "https://github.com/acme/project-1",
              project_key: "project-1",
              source: "gemini",
              hour_start: "2026-06-30T00:00:00.000Z",
              totals: { total_tokens: 5 },
            },
          },
          projects: {
            "project-1": { status: "blocked", purge_pending: true },
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      projectQueuePath,
      JSON.stringify({
        project_ref: "https://github.com/acme/project-1",
        project_key: "project-1",
        source: "gemini",
        hour_start: "2026-06-30T00:00:00.000Z",
        total_tokens: 5,
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 0 }), "utf8");

    await cmdSync(["--auto", "--from-notify", "--source=gemini"]);

    const cursors = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
    assert.equal(cursors.projectHourly.projects["project-1"].purge_pending, true);
    const projectQueue = await fs.readFile(projectQueuePath, "utf8");
    assert.match(projectQueue, /"project_key":"project-1"/);
  });
});

test("full sync still runs project purge reconciliation", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const projectQueueStatePath = path.join(trackerDir, "project.queue.state.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      cursorsPath,
      JSON.stringify({
        version: 1,
        files: {},
        projectHourly: {
          buckets: {
            "project-1|gemini|2026-06-30T00:00:00.000Z": {
              project_ref: "https://github.com/acme/project-1",
              project_key: "project-1",
              source: "gemini",
              hour_start: "2026-06-30T00:00:00.000Z",
              totals: { total_tokens: 5 },
            },
            "project-2|gemini|2026-06-30T00:00:00.000Z": {
              project_ref: "https://github.com/acme/project-2",
              project_key: "project-2",
              source: "gemini",
              hour_start: "2026-06-30T00:00:00.000Z",
              totals: { total_tokens: 7 },
            },
          },
          projects: {
            "project-1": { status: "blocked", purge_pending: true },
            "project-2": { status: "public_verified", purge_pending: false },
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      projectQueuePath,
      [
        JSON.stringify({
          project_ref: "https://github.com/acme/project-1",
          project_key: "project-1",
          source: "gemini",
          hour_start: "2026-06-30T00:00:00.000Z",
          total_tokens: 5,
        }),
        JSON.stringify({
          project_ref: "https://github.com/acme/project-2",
          project_key: "project-2",
          source: "gemini",
          hour_start: "2026-06-30T00:00:00.000Z",
          total_tokens: 7,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 999 }), "utf8");

    await cmdSync(["--auto"]);

    const cursors = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
    assert.equal(cursors.projectHourly.projects["project-1"].purge_pending, false);
    assert.ok(!cursors.projectHourly.buckets["project-1|gemini|2026-06-30T00:00:00.000Z"]);
    assert.ok(cursors.projectHourly.buckets["project-2|gemini|2026-06-30T00:00:00.000Z"]);
    const projectQueue = await fs.readFile(projectQueuePath, "utf8");
    assert.doesNotMatch(projectQueue, /"project_key":"project-1"/);
    assert.match(projectQueue, /"project_key":"project-2"/);
  });
});

test("manual sync remains a full scan and discovers Codex usage", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-5555-7666-8777-888888888888",
      33,
    );

    const sessionsRoot = path.join(codexHome, "sessions");
    const { count } = await countReaddir(
      () => cmdSync([]),
      (target) => target.startsWith(sessionsRoot),
    );

    assert.ok(count > 0, "manual sync must enumerate Codex sessions");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":33/);
  });
});

test("full auto sync still scans flat Codex archives", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeArchivedCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6666-7777-8888-999999999999",
      29,
    );

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const { count } = await countReaddir(
      () => cmdSync(["--auto"]),
      (target) => target.startsWith(archiveRoot),
    );

    assert.ok(count > 0, "full auto sync must enumerate archived Codex sessions");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":29/);
  });
});

test("background auto sync stays bounded and skips deep Codex archives", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6777-7777-8888-999999999999",
      31,
    );
    await writeNestedArchivedCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6888-7777-8888-999999999999",
      47,
    );

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => target.startsWith(archiveRoot),
    );

    assert.equal(count, 0, "background auto sync must not enumerate archived Codex sessions");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":31/);
    assert.doesNotMatch(queue, /"total_tokens":47/);
  });
});

test("background auto sync does not enumerate broad provider roots", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6ddd-7777-8888-999999999999",
      22,
    );
    const broadRoots = [
      path.join(home, ".claude"),
      path.join(home, ".gemini"),
      path.join(home, ".opencode"),
      path.join(home, ".local", "share", "mimocode"),
      path.join(home, ".workbuddy"),
    ];
    await Promise.all(broadRoots.map((root) => fs.mkdir(root, { recursive: true })));

    const { count } = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => broadRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)),
    );

    assert.equal(count, 0, "background auto sync must not walk broad non-bounded provider roots");
    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":22/);
  });
});

test("background auto sync does not upload even when cloud credentials exist", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6eee-7777-8888-999999999999",
      24,
    );
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://example.invalid";
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("background sync should not upload");
    };

    try {
      await cmdSync(["--auto", "--background"]);
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(fetchCalls, 0, "background auto sync must not call cloud ingest");
    const queueState = await fs.stat(path.join(home, ".tokentracker", "tracker", "queue.state.json")).catch(() => null);
    assert.equal(queueState, null, "background auto sync must not advance upload state");
  });
});

test("lightweight flag is an alias for bounded background sync", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6999-7777-8888-999999999999",
      36,
    );
    await writeArchivedCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6aaa-7777-8888-999999999999",
      58,
    );

    await cmdSync(["--auto", "--lightweight"]);

    const queue = await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":36/);
    assert.doesNotMatch(queue, /"total_tokens":58/);
  });
});

test("second unchanged background sync does not deep-read archive descendants or change queue", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    const historicalRolloutPath = await writeCodexRollout(
      codexHome,
      "2026-01-01",
      "019f16bd-6bb0-7777-8888-999999999999",
      17,
    );
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6bbb-7777-8888-999999999999",
      41,
    );
    await writeNestedArchivedCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-6ccc-7777-8888-999999999999",
      67,
    );

    await cmdSync(["--auto", "--background"]);
    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
    const before = await fs.readFile(queuePath, "utf8");

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const { count: archiveReads, value: historicalStats } = await countReaddir(
      () => countStat(
        () => cmdSync(["--auto", "--background"]),
        (target) => target === historicalRolloutPath,
      ),
      (target) => target.startsWith(`${archiveRoot}${path.sep}`),
    );
    const after = await fs.readFile(queuePath, "utf8");

    assert.equal(archiveReads, 0, "second background sync must not readdir descendants under archived_sessions");
    assert.equal(
      historicalStats.count,
      0,
      "second background sync must cold-skip already parsed historical Codex rollout files",
    );
    assert.equal(after, before, "idle background sync must leave Codex queue output stable");
    assert.match(after, /"total_tokens":17/);
    assert.match(after, /"total_tokens":41/);
    assert.doesNotMatch(after, /"total_tokens":67/);
  });
});

test("full auto sync persists Codex day inventory cache between runs", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    const rolloutPath = await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-9999-7000-8000-999999999999",
      21,
    );
    const dayDir = path.dirname(rolloutPath);

    await cmdSync(["--auto"]);

    const cursorsPath = path.join(home, ".tokentracker", "tracker", "cursors.json");
    const cursors = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
    assert.equal(cursors.codexDayInventoryCache?.version, 1);
    assert.ok(cursors.codexDayInventoryCache.days[dayDir], "first sync should cache the Codex day");

    const { count } = await countReaddir(
      () => cmdSync(["--auto"]),
      (target) => target === dayDir,
    );
    assert.equal(count, 0, "unchanged cached day should not be readdir'd on the next full auto sync");
  });
});

test("full auto sync cold-skips historical Codex rollout file stats after audit baseline", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    const rolloutPath = await writeCodexRollout(
      codexHome,
      "2026-01-01",
      "019f16bd-aaaa-7000-8000-aaaaaaaaaaaa",
      29,
    );
    await writeCodexRollout(
      codexHome,
      "2026-07-02",
      "019f16bd-bbbb-7000-8000-bbbbbbbbbbbb",
      31,
    );

    await cmdSync(["--auto"]);
    const { count } = await countStat(
      () => cmdSync(["--auto"]),
      (target) => target === rolloutPath,
    );

    assert.equal(count, 0, "historical EOF Codex rollout should not be stat'ed on idle sync");
    const cursors = JSON.parse(
      await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
    );
    assert.equal(cursors.codexColdScanAudit.lastSkippedFiles, 1);
  });
});

test("manual sync still stats historical Codex rollouts after auto cold-skip baseline", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    const rolloutPath = await writeCodexRollout(
      codexHome,
      "2026-01-01",
      "019f16bd-cccc-7000-8000-cccccccccccc",
      37,
    );
    await writeCodexRollout(
      codexHome,
      "2026-07-02",
      "019f16bd-dddd-7000-8000-dddddddddddd",
      41,
    );

    await cmdSync(["--auto"]);
    const { count } = await countStat(
      () => cmdSync([]),
      (target) => target === rolloutPath,
    );

    assert.ok(count > 0, "manual full sync should keep historical file validation");
  });
});

test("Codex cold scan audit treats future full-scan timestamps as due", () => {
  const nowMs = Date.UTC(2026, 6, 2, 0, 0, 0);

  assert.equal(
    isCodexColdScanAuditDue({
      codexColdScanAudit: {
        version: 1,
        lastFullScanAtMs: nowMs + 10 * 60 * 1000,
        syncsSinceFullScan: 0,
      },
    }, nowMs),
    true,
  );
  assert.equal(
    isCodexColdScanAuditDue({
      codexColdScanAudit: {
        version: 1,
        lastFullScanAtMs: nowMs - 60 * 60 * 1000,
        syncsSinceFullScan: 0,
      },
    }, nowMs),
    false,
  );
  assert.equal(
    isCodexColdScanAuditDue({
      codexColdScanAudit: {
        version: 1,
        lastFullScanAtMs: nowMs - 25 * 60 * 60 * 1000,
        syncsSinceFullScan: 0,
      },
    }, nowMs),
    true,
  );
  assert.equal(
    isCodexColdScanAuditDue({
      codexColdScanAudit: {
        version: 1,
        lastFullScanAtMs: nowMs - 60 * 60 * 1000,
        syncsSinceFullScan: 288,
      },
    }, nowMs),
    true,
  );
  assert.equal(
    isCodexColdScanAuditDue({
      codexColdScanAudit: {
        version: 1,
        lastFullScanAtMs: nowMs - 60 * 60 * 1000,
        syncsSinceFullScan: 7,
      },
    }, nowMs, 281),
    true,
  );
});

test("Codex day inventory cache reduces repeated old-day readdir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cache-"));
  try {
    const sessionsDir = path.join(tmp, "sessions");
    await writeCodexRollout(tmp, "2026-06-28", "019f16bd-aaaa-7000-8000-aaaaaaaaaaaa", 1);
    await writeCodexRollout(tmp, "2026-06-29", "019f16bd-bbbb-7000-8000-bbbbbbbbbbbb", 2);

    const cache = { version: 1, days: {} };
    const firstStats = {};
    const first = await countReaddir(() =>
      listRolloutFiles(sessionsDir, { dayInventoryCache: cache, stats: firstStats }),
    );
    const secondStats = {};
    const second = await countReaddir(() =>
      listRolloutFiles(sessionsDir, { dayInventoryCache: cache, stats: secondStats }),
    );

    assert.deepEqual(second.value, first.value);
    assert.ok(
      second.count < first.count,
      `expected fewer readdir calls on cache hit; first=${first.count}, second=${second.count}`,
    );
    assert.equal(secondStats.dayInventoryCacheHits, 2);
    console.log(
      `codex day inventory cache readdir counts: first=${first.count} second=${second.count}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Codex day inventory cache invalidates when a day directory changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cache-"));
  try {
    const sessionsDir = path.join(tmp, "sessions");
    await writeCodexRollout(tmp, "2026-06-28", "019f16bd-cccc-7000-8000-cccccccccccc", 1);

    const cache = { version: 1, days: {} };
    await listRolloutFiles(sessionsDir, { dayInventoryCache: cache });

    const added = await writeCodexRollout(
      tmp,
      "2026-06-28",
      "019f16bd-dddd-7000-8000-dddddddddddd",
      2,
    );
    const dayDir = path.dirname(added);
    const future = new Date(Date.now() + 2000);
    await fs.utimes(dayDir, future, future);

    const stats = {};
    const found = await listRolloutFiles(sessionsDir, { dayInventoryCache: cache, stats });
    assert.ok(found.includes(added), "changed day directory must be re-read");
    assert.equal(stats.dayInventoryCacheMisses, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Codex day inventory cache falls back safely when cache data is corrupt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cache-"));
  try {
    const sessionsDir = path.join(tmp, "sessions");
    const rolloutPath = await writeCodexRollout(
      tmp,
      "2026-06-28",
      "019f16bd-eeee-7000-8000-eeeeeeeeeeee",
      1,
    );
    const dayDir = path.dirname(rolloutPath);
    const cache = { version: 1, days: { [dayDir]: { statKey: "corrupt", files: "not-an-array" } } };

    const stats = {};
    const found = await listRolloutFiles(sessionsDir, { dayInventoryCache: cache, stats });
    assert.deepEqual(found, [rolloutPath]);
    assert.equal(stats.dayInventoryCacheMisses, 1);
    assert.ok(Array.isArray(cache.days[dayDir].files), "corrupt cache entry should be replaced");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Codex day inventory cache rejects corrupt cached filenames", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cache-"));
  try {
    const sessionsDir = path.join(tmp, "sessions");
    const rolloutPath = await writeCodexRollout(
      tmp,
      "2026-06-28",
      "019f16bd-abcd-7000-8000-abcdabcdabcd",
      1,
    );
    const dayDir = path.dirname(rolloutPath);
    const cache = { version: 1, days: {} };
    await listRolloutFiles(sessionsDir, { dayInventoryCache: cache });
    for (const badName of ["rollout-x/evil.jsonl", "rollout-x\\evil.jsonl", "../rollout-x.jsonl"]) {
      cache.days[dayDir].files = [badName];

      const stats = {};
      const found = await listRolloutFiles(sessionsDir, { dayInventoryCache: cache, stats });
      assert.deepEqual(found, [rolloutPath]);
      assert.equal(stats.dayInventoryCacheMisses, 1);
      assert.ok(cache.days[dayDir].files.includes(path.basename(rolloutPath)));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Codex day inventory cache discards incompatible cache versions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-cache-"));
  try {
    const sessionsDir = path.join(tmp, "sessions");
    const rolloutPath = await writeCodexRollout(
      tmp,
      "2026-06-28",
      "019f16bd-ffff-7000-8000-ffffffffffff",
      1,
    );
    const dayDir = path.dirname(rolloutPath);
    const cache = { version: 1, days: {} };
    await listRolloutFiles(sessionsDir, { dayInventoryCache: cache });

    cache.version = 0;
    cache.days[dayDir].files = [];

    const found = await listRolloutFiles(sessionsDir, { dayInventoryCache: cache });
    assert.deepEqual(found, [rolloutPath]);
    assert.equal(cache.version, 1);
    assert.ok(cache.days[dayDir].files.includes(path.basename(rolloutPath)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
