const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");

function tokenCountLine({ ts, totalTokens }) {
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } },
  });
}

async function writeCodexRollout(codexHome, date, uuid, totalTokens) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function writeEveryCodeRollout(codeHome, date, uuid, totalTokens) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codeHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function writeArchivedCodexRollout(codexHome, date, uuid, totalTokens) {
  const dir = path.join(codexHome, "archived_sessions", "nested", uuid);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function withTempSyncEnv(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-background-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_INSFORGE_BASE_URL: process.env.TOKENTRACKER_INSFORGE_BASE_URL,
    TOKENTRACKER_OPENCLAW_HOME: process.env.TOKENTRACKER_OPENCLAW_HOME,
    TOKENTRACKER_OPENCLAW_AGENT_ID: process.env.TOKENTRACKER_OPENCLAW_AGENT_ID,
    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID,
    TOKENTRACKER_OPENCLAW_SESSION_KEY: process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY,
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
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY;
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
    await fn();
    return count;
  } finally {
    fs.readdir = realReaddir;
  }
}

async function readQueue(home) {
  return fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
}

async function readCursors(home) {
  return JSON.parse(await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"));
}

test("background auto sync skips deep Codex archives", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1000-7000-8000-aaaaaaaaaaaa", 31);
    await writeArchivedCodexRollout(codexHome, "2026-06-30", "019f16bd-1001-7000-8000-aaaaaaaaaaaa", 47);

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const archiveReads = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => target === archiveRoot || target.startsWith(`${archiveRoot}${path.sep}`),
    );

    assert.equal(archiveReads, 0);
    const queue = await readQueue(home);
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":31/);
    assert.doesNotMatch(queue, /"total_tokens":47/);
  });
});

test("background auto sync still includes Every Code sessions", async () => {
  await withTempSyncEnv(async (home) => {
    const codeHome = process.env.CODE_HOME;
    await writeEveryCodeRollout(codeHome, "2026-06-30", "019f16bd-1006-7000-8000-aaaaaaaaaaaa", 42);

    await cmdSync(["--auto", "--background"]);

    const queue = await readQueue(home);
    assert.match(queue, /"source":"every-code"/);
    assert.match(queue, /"total_tokens":42/);
  });
});

test("scoped background sync rejects non-lightweight sources", async () => {
  await withTempSyncEnv(async (home) => {
    const claudeProjectsDir = path.join(home, ".claude", "projects");
    await fs.mkdir(path.join(claudeProjectsDir, "sample"), { recursive: true });

    const claudeReads = await countReaddir(
      () => cmdSync(["--auto", "--background", "--from-notify", "--source=claude"]),
      (target) => target === claudeProjectsDir || target.startsWith(`${claudeProjectsDir}${path.sep}`),
    );

    assert.equal(claudeReads, 0);
    await assert.rejects(readQueue(home), { code: "ENOENT" });
  });
});

test("background auto sync avoids broad provider traversal", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1002-7000-8000-aaaaaaaaaaaa", 22);
    const broadRoots = [
      path.join(home, ".claude"),
      path.join(home, ".gemini"),
      path.join(home, ".opencode"),
      path.join(home, ".local", "share", "mimocode"),
      path.join(home, ".workbuddy"),
    ];
    await Promise.all(broadRoots.map((root) => fs.mkdir(root, { recursive: true })));

    const broadReads = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => broadRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)),
    );

    assert.equal(broadReads, 0);
    const queue = await readQueue(home);
    assert.match(queue, /"total_tokens":22/);
  });
});

test("background auto sync skips full-source migration and backfill work", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      cursorsPath,
      JSON.stringify({
        version: 1,
        files: {},
        hourly: {
          buckets: {
            "codex|gpt-5.5|2026-06-30T00:00:00.000Z": {
              totals: { total_tokens: 99 },
            },
          },
          groupQueued: {
            "codex|2026-06-30T00:00:00.000Z": "old",
          },
        },
        migrations: {},
      }),
      "utf8",
    );
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");

    await cmdSync(["--auto", "--background"]);

    const cursors = await readCursors(home);
    assert.equal(cursors.migrations.rolloutCumulativeDeltaReparse_2026_05, undefined);
    assert.equal(cursors.migrations.cloudConversationsBackfill_2026_06, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(queueStatePath, "utf8")), { offset: 123 });
    await assert.rejects(readQueue(home), { code: "ENOENT" });
  });
});

test("background auto sync does not upload with cloud credentials", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1003-7000-8000-aaaaaaaaaaaa", 24);
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

    assert.equal(fetchCalls, 0);
    assert.equal(await fs.stat(path.join(home, ".tokentracker", "tracker", "queue.state.json")).catch(() => null), null);
  });
});

test("lightweight flag aliases bounded background sync", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1004-7000-8000-aaaaaaaaaaaa", 36);
    await writeArchivedCodexRollout(codexHome, "2026-06-30", "019f16bd-1005-7000-8000-aaaaaaaaaaaa", 58);

    await cmdSync(["--auto", "--lightweight"]);

    const queue = await readQueue(home);
    assert.match(queue, /"total_tokens":36/);
    assert.doesNotMatch(queue, /"total_tokens":58/);
  });
});
