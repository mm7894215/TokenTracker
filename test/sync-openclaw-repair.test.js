"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  OPENCLAW_RESCAN_REPAIR_KEY,
  cmdSync,
  repairOpenclawRescanInflation,
} = require("../src/commands/sync");
const { parseOpenclawIncremental } = require("../src/lib/rollout");

function usageLine({
  id,
  timestamp,
  model = "claude-opus-4.7",
  input = 1_200,
  cacheRead = 1_000,
  cacheWrite = 81_071,
  output = 50,
}) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      model,
      usage: {
        input,
        cacheRead,
        cacheWrite,
        output,
        totalTokens: input + cacheWrite + output,
      },
    },
  });
}

function row({
  source = "openclaw",
  model,
  hourStart,
  input = 0,
  cached = 0,
  cacheWrite = 0,
  output = 0,
  conversations = 0,
}) {
  return JSON.stringify({
    source,
    model,
    hour_start: hourStart,
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + cached + cacheWrite + output,
    billable_total_tokens: input + cached + cacheWrite + output,
    conversation_count: conversations,
  });
}

async function readRows(queuePath) {
  return (await fs.readFile(queuePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestByKey(rows) {
  const latest = new Map();
  for (const value of rows) {
    latest.set(`${value.source}|${value.model}|${value.hour_start}`, value);
  }
  return latest;
}

async function makeInflatedInstall() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-repair-"));
  const sessionDir = path.join(home, ".openclaw", "agents", "claude", "sessions");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(trackerDir, { recursive: true });

  const sessionPath = path.join(sessionDir, "session-a.jsonl");
  const fallbackPath = path.join(trackerDir, "openclaw.fallback.jsonl");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const queueStatePath = path.join(trackerDir, "queue.state.json");
  const mainHour = "2026-07-07T13:30:00.000Z";
  const fallbackHour = "2026-07-08T09:00:00.000Z";
  const staleHour = "2026-07-06T12:00:00.000Z";
  const mainKey = `openclaw|claude-opus-4.7|${mainHour}`;
  const fallbackKey = `openclaw|gpt-5|${fallbackHour}`;
  const staleKey = `openclaw|claude-opus-4.7|${staleHour}`;

  await fs.writeFile(
    sessionPath,
    [
      usageLine({ id: "event-1", timestamp: "2026-07-07T13:31:00.000Z" }),
      usageLine({ id: "event-2", timestamp: "2026-07-07T13:32:00.000Z" }),
    ].join("\n") + "\n",
    "utf8",
  );
  await fs.writeFile(
    fallbackPath,
    usageLine({
      id: "fallback-1",
      timestamp: "2026-07-08T09:01:00.000Z",
      model: "gpt-5",
      input: 84,
      cacheRead: 0,
      cacheWrite: 0,
      output: 30,
    }) + "\n",
    "utf8",
  );
  const sessionStat = await fs.stat(sessionPath);
  const fallbackStat = await fs.stat(fallbackPath);

  const uploadedPrefix =
    row({
      source: "claude",
      model: "claude-opus-4.7",
      hourStart: mainHour,
      input: 777,
      conversations: 1,
    }) + "\n";
  const pendingRows = [
    row({
      model: "claude-opus-4.7",
      hourStart: mainHour,
      cacheWrite: 11_187_798,
      conversations: 138,
    }),
    row({
      model: "gpt-5",
      hourStart: fallbackHour,
      input: 84,
      output: 30,
      conversations: 1,
    }),
    row({
      model: "claude-opus-4.7",
      hourStart: staleHour,
      cacheWrite: 999_999,
      conversations: 12,
    }),
  ].join("\n") + "\n";
  await fs.writeFile(queuePath, uploadedPrefix + pendingRows, "utf8");
  await fs.writeFile(
    queueStatePath,
    JSON.stringify({ offset: Buffer.byteLength(uploadedPrefix), updatedAt: "2026-07-09T00:00:00.000Z" }),
    "utf8",
  );

  const totals = (cacheWrite, total, conversations) => ({
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
    conversation_count: conversations,
  });
  const cursors = {
    version: 1,
    files: {
      [sessionPath]: { inode: sessionStat.ino, offset: sessionStat.size },
      [fallbackPath]: { inode: fallbackStat.ino, offset: fallbackStat.size },
    },
    hourly: {
      version: 3,
      buckets: {
        [mainKey]: { totals: totals(11_187_798, 11_187_798, 138) },
        [fallbackKey]: {
          totals: {
            ...totals(0, 114, 1),
            input_tokens: 84,
            output_tokens: 30,
          },
        },
        [staleKey]: { totals: totals(999_999, 999_999, 12) },
      },
      groupQueued: {
        [`openclaw|${mainHour}`]: "inflated",
        [`openclaw|${fallbackHour}`]: "fallback",
        [`openclaw|${staleHour}`]: "stale",
      },
    },
    migrations: {},
  };

  return {
    home,
    sessionPath,
    fallbackPath,
    queuePath,
    queueStatePath,
    uploadedPrefix,
    cursors,
    keys: { mainKey, fallbackKey, staleKey },
  };
}

test("repairOpenclawRescanInflation appends provable corrections and is stable across repair and parse reruns", async () => {
  const install = await makeInflatedInstall();
  try {
    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });
    assert.equal(changed, true);

    const raw = await fs.readFile(install.queuePath, "utf8");
    assert.ok(raw.startsWith(install.uploadedPrefix), "already-uploaded queue prefix must remain byte-stable");
    assert.equal(
      JSON.parse(await fs.readFile(install.queueStatePath, "utf8")).offset,
      Buffer.byteLength(install.uploadedPrefix),
      "repair must preserve the cloud upload offset",
    );

    const latest = latestByKey(await readRows(install.queuePath));
    assert.equal(latest.get(install.keys.mainKey).cache_creation_input_tokens, 162_142);
    assert.equal(latest.get(install.keys.mainKey).conversation_count, 2);
    assert.equal(latest.get(install.keys.fallbackKey).total_tokens, 114);
    assert.equal(
      latest.get(install.keys.staleKey).total_tokens,
      999_999,
      "unreproduced compacted history must not be retracted",
    );
    assert.equal(latest.get(install.keys.staleKey).conversation_count, 12);
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      164_642,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.fallbackKey].totals.total_tokens,
      114,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.staleKey].totals.total_tokens,
      999_999,
    );
    assert.equal(install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status, "done");
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY]
        .preservedUnreproducedBuckets,
      1,
    );

    const afterFirstRepair = await fs.readFile(install.queuePath, "utf8");
    assert.equal(
      await repairOpenclawRescanInflation({
        cursors: install.cursors,
        queuePath: install.queuePath,
        queueStatePath: install.queueStatePath,
      }),
      false,
    );
    assert.equal(await fs.readFile(install.queuePath, "utf8"), afterFirstRepair);

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [
        { path: install.sessionPath, source: "openclaw" },
        { path: install.fallbackPath, source: "openclaw" },
      ],
      cursors: install.cursors,
      queuePath: install.queuePath,
    });
    assert.equal(parsed.eventsAggregated, 0, "same-sync parse must not replay repaired files");
    assert.equal(await fs.readFile(install.queuePath, "utf8"), afterFirstRepair);
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation defers when any tracked session file is missing", async () => {
  const install = await makeInflatedInstall();
  try {
    const missingPath = path.join(
      install.home,
      ".openclaw",
      "agents",
      "claude",
      "sessions",
      "missing.jsonl",
    );
    install.cursors.files[missingPath] = { inode: 3, offset: 20 };
    const before = await fs.readFile(install.queuePath, "utf8");

    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });
    assert.equal(changed, false);
    assert.equal(await fs.readFile(install.queuePath, "utf8"), before);
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].reason,
      "openclaw_session_unreproducible",
    );

    const beforeParseTotal =
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens;
    const parsed = await parseOpenclawIncremental({
      sessionFiles: [install.sessionPath],
      cursors: install.cursors,
      queuePath: install.queuePath,
    });
    assert.equal(parsed.eventsAggregated, 0);
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      beforeParseTotal,
      "a deferred repair must not make a legacy cursor replay history",
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("two OpenClaw syncs keep the repaired aggregate stable", async () => {
  const install = await makeInflatedInstall();
  const savedEnv = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_OPENCLAW_AGENT_ID: process.env.TOKENTRACKER_OPENCLAW_AGENT_ID,
    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID:
      process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID,
    TOKENTRACKER_OPENCLAW_HOME: process.env.TOKENTRACKER_OPENCLAW_HOME,
    TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS:
      process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS,
  };
  try {
    const trackerDir = path.dirname(install.queuePath);
    await fs.writeFile(
      path.join(trackerDir, "cursors.json"),
      `${JSON.stringify(install.cursors, null, 2)}\n`,
      "utf8",
    );
    process.env.HOME = install.home;
    process.env.CODEX_HOME = path.join(install.home, ".codex");
    process.env.CODE_HOME = path.join(install.home, ".code");
    process.env.GEMINI_HOME = path.join(install.home, ".gemini");
    process.env.OPENCODE_HOME = path.join(install.home, ".opencode");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.TOKENTRACKER_OPENCLAW_AGENT_ID = "claude";
    process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID = "session-a";
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(install.home, ".openclaw");
    delete process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS;

    await cmdSync(["--from-openclaw"]);
    const afterFirst = await fs.readFile(install.queuePath, "utf8");
    await cmdSync(["--from-openclaw"]);
    const afterSecond = await fs.readFile(install.queuePath, "utf8");
    assert.equal(afterSecond, afterFirst);

    const latest = latestByKey(await readRows(install.queuePath));
    assert.equal(latest.get(install.keys.mainKey).total_tokens, 164_642);
    assert.equal(latest.get(install.keys.mainKey).conversation_count, 2);
    const persistedCursors = JSON.parse(
      await fs.readFile(path.join(trackerDir, "cursors.json"), "utf8"),
    );
    assert.equal(
      persistedCursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
      "done",
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(install.home, { recursive: true, force: true });
  }
});
