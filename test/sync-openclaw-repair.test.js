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
const {
  openclawCursorKey,
  parseOpenclawIncremental,
} = require("../src/lib/rollout");
const { mockMethod } = require("./helpers/mock");

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

function openclawCursor(cursors, filePath) {
  return cursors.files[openclawCursorKey(filePath)];
}

async function makeInflatedInstall({
  openclawDirName = ".openclaw",
  historicalInput = 0,
} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-repair-"));
  const openclawHome = path.join(home, openclawDirName);
  const sessionDir = path.join(openclawHome, "agents", "claude", "sessions");
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
  const groundTruth = {
    input: 400,
    cached: 2_000,
    cacheWrite: 162_142,
    output: 100,
    conversations: 2,
  };
  const replayVersions = 138;
  const replayRows = Array.from({ length: replayVersions }, (_, index) => {
    const multiplier = index + 1;
    return row({
      model: "claude-opus-4.7",
      hourStart: mainHour,
      input: historicalInput + groundTruth.input * multiplier,
      cached: groundTruth.cached * multiplier,
      cacheWrite: groundTruth.cacheWrite * multiplier,
      output: groundTruth.output * multiplier,
      conversations: groundTruth.conversations * multiplier,
    });
  });
  const pendingRows = [
    ...replayRows,
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
        [mainKey]: {
          totals: {
            input_tokens:
              historicalInput + groundTruth.input * replayVersions,
            cached_input_tokens: groundTruth.cached * replayVersions,
            cache_creation_input_tokens:
              groundTruth.cacheWrite * replayVersions,
            output_tokens: groundTruth.output * replayVersions,
            reasoning_output_tokens: 0,
            total_tokens:
              historicalInput +
              (groundTruth.input +
                groundTruth.cached +
                groundTruth.cacheWrite +
                groundTruth.output) *
                replayVersions,
            billable_total_tokens:
              historicalInput +
              (groundTruth.input +
                groundTruth.cached +
                groundTruth.cacheWrite +
                groundTruth.output) *
                replayVersions,
            conversation_count:
              groundTruth.conversations * replayVersions,
          },
        },
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
    openclawHome,
    sessionPath,
    fallbackPath,
    queuePath,
    queueStatePath,
    uploadedPrefix,
    cursors,
    expectedMain: {
      input: historicalInput + groundTruth.input,
      cached: groundTruth.cached,
      cacheWrite: groundTruth.cacheWrite,
      output: groundTruth.output,
      total:
        historicalInput +
        groundTruth.input +
        groundTruth.cached +
        groundTruth.cacheWrite +
        groundTruth.output,
      conversations: groundTruth.conversations,
    },
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
    assert.equal(
      latest.get(install.keys.mainKey).cache_creation_input_tokens,
      install.expectedMain.cacheWrite,
    );
    assert.equal(
      latest.get(install.keys.mainKey).conversation_count,
      install.expectedMain.conversations,
    );
    assert.equal(latest.get(install.keys.fallbackKey).total_tokens, 114);
    assert.equal(
      latest.get(install.keys.staleKey).total_tokens,
      999_999,
      "unreproduced compacted history must not be retracted",
    );
    assert.equal(latest.get(install.keys.staleKey).conversation_count, 12);
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.fallbackKey].totals.total_tokens,
      114,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.staleKey].totals.total_tokens,
      999_999,
    );
    assert.equal(
      install.cursors.hourly.groupQueued["openclaw|2026-07-07T13:30:00.000Z"],
      undefined,
    );
    assert.equal(install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status, "done");
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY]
        .preservedUnprovenBuckets,
      2,
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
    assert.ok(
      Object.keys(openclawCursor(install.cursors, install.sessionPath).usageEvents)
        .length >
        0,
      "the legacy cursor should adopt a metadata-only identity baseline",
    );
    assert.equal(
      openclawCursor(install.cursors, install.sessionPath).usageFingerprint?.version,
      1,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation defers when queue state JSON is malformed", async () => {
  const install = await makeInflatedInstall();
  try {
    await fs.writeFile(install.queueStatePath, "{not-json", "utf8");
    const queueBefore = await fs.readFile(install.queuePath, "utf8");
    const usageStateBefore = structuredClone({
      files: install.cursors.files,
      hourly: install.cursors.hourly,
    });

    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    assert.equal(changed, false);
    assert.equal(await fs.readFile(install.queuePath, "utf8"), queueBefore);
    assert.deepEqual(
      {
        files: install.cursors.files,
        hourly: install.cursors.hourly,
      },
      usageStateBefore,
    );
    assert.deepEqual(
      {
        status: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
        reason: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].reason,
      },
      {
        status: "deferred",
        reason: "openclaw_queue_offset_invalid",
      },
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation defers when queue state JSON is not an object", async () => {
  const install = await makeInflatedInstall();
  try {
    await fs.writeFile(install.queueStatePath, "[]", "utf8");
    const queueBefore = await fs.readFile(install.queuePath, "utf8");
    const usageStateBefore = structuredClone({
      files: install.cursors.files,
      hourly: install.cursors.hourly,
    });

    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    assert.equal(changed, false);
    assert.equal(await fs.readFile(install.queuePath, "utf8"), queueBefore);
    assert.deepEqual(
      {
        files: install.cursors.files,
        hourly: install.cursors.hourly,
      },
      usageStateBefore,
    );
    assert.deepEqual(
      {
        status: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
        reason: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].reason,
      },
      {
        status: "deferred",
        reason: "openclaw_queue_offset_invalid",
      },
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation defers when queue state cannot be read", async (t) => {
  const install = await makeInflatedInstall();
  const realReadFile = fs.readFile.bind(fs);
  try {
    const queueBefore = await realReadFile(install.queuePath, "utf8");
    const usageStateBefore = structuredClone({
      files: install.cursors.files,
      hourly: install.cursors.hourly,
    });
    mockMethod(t, fs, "readFile", async (filePath, ...args) => {
      if (path.resolve(String(filePath)) === path.resolve(install.queueStatePath)) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return realReadFile(filePath, ...args);
    });

    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    assert.equal(changed, false);
    assert.equal(await realReadFile(install.queuePath, "utf8"), queueBefore);
    assert.deepEqual(
      {
        files: install.cursors.files,
        hourly: install.cursors.hourly,
      },
      usageStateBefore,
    );
    assert.deepEqual(
      {
        status: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
        reason: install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].reason,
      },
      {
        status: "deferred",
        reason: "openclaw_queue_offset_invalid",
      },
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation recovers 138 growing rewrites whose newest snapshot appears once", async () => {
  const install = await makeInflatedInstall();
  try {
    const events = [
      usageLine({ id: "event-1", timestamp: "2026-07-07T13:31:00.000Z" }),
      usageLine({ id: "event-2", timestamp: "2026-07-07T13:32:00.000Z" }),
      usageLine({ id: "event-3", timestamp: "2026-07-07T13:33:00.000Z" }),
    ];
    await fs.writeFile(
      install.sessionPath,
      `${events.join("\n")}\n`,
      "utf8",
    );
    const stat = await fs.stat(install.sessionPath);
    install.cursors.files[install.sessionPath].offset = stat.size;
    install.cursors.files[install.sessionPath].inode = stat.ino;

    const snapshot = {
      input: 200,
      cached: 1_000,
      cacheWrite: 81_071,
      output: 50,
      total: 82_321,
      conversations: 1,
    };
    const cumulativeMultipliers = [1];
    let cumulative = 1;
    for (let replay = 1; replay < 138; replay += 1) {
      const snapshotMultiplier = replay < 70 ? 1 : replay < 137 ? 2 : 3;
      cumulative += snapshotMultiplier;
      cumulativeMultipliers.push(cumulative);
    }
    const rows = await readRows(install.queuePath);
    const nonMainRows = rows.slice(1).filter(
      (value) =>
        `${value.source}|${value.model}|${value.hour_start}` !==
        install.keys.mainKey,
    );
    const growingRows = cumulativeMultipliers.map((multiplier) =>
      row({
        model: "claude-opus-4.7",
        hourStart: "2026-07-07T13:30:00.000Z",
        input: snapshot.input * multiplier,
        cached: snapshot.cached * multiplier,
        cacheWrite: snapshot.cacheWrite * multiplier,
        output: snapshot.output * multiplier,
        conversations: snapshot.conversations * multiplier,
      }),
    );
    await fs.writeFile(
      install.queuePath,
      install.uploadedPrefix +
        `${[...growingRows, ...nonMainRows.map(JSON.stringify)].join("\n")}\n`,
      "utf8",
    );
    const inflated = install.cursors.hourly.buckets[install.keys.mainKey].totals;
    inflated.input_tokens = snapshot.input * 7;
    inflated.cached_input_tokens = snapshot.cached * 7;
    inflated.cache_creation_input_tokens = snapshot.cacheWrite * 7;
    inflated.output_tokens = snapshot.output * 7;
    inflated.total_tokens = snapshot.total * 7;
    inflated.billable_total_tokens = snapshot.total * 7;
    inflated.conversation_count = 7;

    await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    const latest = latestByKey(await readRows(install.queuePath));
    assert.equal(
      latest.get(install.keys.mainKey).total_tokens,
      snapshot.total * 3,
    );
    assert.equal(
      latest.get(install.keys.mainKey).conversation_count,
      3,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      snapshot.total * 3,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation recovers after queue replacement before cursor persistence", async (t) => {
  const install = await makeInflatedInstall();
  const persistedBefore = JSON.parse(JSON.stringify(install.cursors));
  const realRename = fs.rename.bind(fs);
  let injected = false;
  mockMethod(t, fs, "rename", async (from, to) => {
    await realRename(from, to);
    if (!injected && to === install.queuePath) {
      injected = true;
      throw new Error("injected crash after queue replacement");
    }
  });
  try {
    await assert.rejects(
      repairOpenclawRescanInflation({
        cursors: install.cursors,
        queuePath: install.queuePath,
        queueStatePath: install.queueStatePath,
      }),
      /injected crash/,
    );
    const markerPath = `${install.queuePath}.openclaw-repair.json`;
    assert.equal((await fs.stat(markerPath)).isFile(), true);

    const restartedCursors = JSON.parse(JSON.stringify(persistedBefore));
    assert.equal(
      await repairOpenclawRescanInflation({
        cursors: restartedCursors,
        queuePath: install.queuePath,
        queueStatePath: install.queueStatePath,
      }),
      true,
    );
    const latest = latestByKey(await readRows(install.queuePath));
    assert.equal(
      latest.get(install.keys.mainKey).total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      restartedCursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      restartedCursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
      "done",
    );
    assert.equal(
      await repairOpenclawRescanInflation({
        cursors: restartedCursors,
        queuePath: install.queuePath,
        queueStatePath: install.queueStatePath,
      }),
      false,
    );
    await assert.rejects(fs.stat(markerPath), { code: "ENOENT" });
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation preserves partially compacted history in a proven replay baseline", async () => {
  const install = await makeInflatedInstall({ historicalInput: 5_000 });
  try {
    await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    const latest = latestByKey(await readRows(install.queuePath));
    assert.equal(
      latest.get(install.keys.mainKey).input_tokens,
      install.expectedMain.input,
    );
    assert.equal(
      latest.get(install.keys.mainKey).total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.input_tokens,
      install.expectedMain.input,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation leaves an uncounted tail for the normal parser", async () => {
  const install = await makeInflatedInstall();
  try {
    const priorOffset = openclawCursor(install.cursors, install.sessionPath).offset;
    await fs.appendFile(
      install.sessionPath,
      `${usageLine({
        id: "event-3",
        timestamp: "2026-07-07T13:33:00.000Z",
      })}\n`,
      "utf8",
    );

    await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });
    assert.equal(
      openclawCursor(install.cursors, install.sessionPath).offset,
      priorOffset,
      "repair must not advance past uncounted bytes",
    );

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [install.sessionPath],
      cursors: install.cursors,
      queuePath: install.queuePath,
    });
    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      install.expectedMain.total + 82_321,
    );
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals
        .conversation_count,
      install.expectedMain.conversations + 1,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation does not lower a rebuilt key without replay proof", async () => {
  const install = await makeInflatedInstall({ historicalInput: 5_000 });
  try {
    const rows = await readRows(install.queuePath);
    const latestMain = rows.filter(
      (value) =>
        `${value.source}|${value.model}|${value.hour_start}` ===
        install.keys.mainKey,
    ).at(-1);
    const otherPending = rows.slice(1).filter(
      (value) =>
        `${value.source}|${value.model}|${value.hour_start}` !==
        install.keys.mainKey,
    );
    await fs.writeFile(
      install.queuePath,
      install.uploadedPrefix +
        [latestMain, ...otherPending]
          .map((value) => JSON.stringify(value))
          .join("\n") +
        "\n",
      "utf8",
    );
    const before =
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens;

    await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      before,
      "current file presence alone must not authorize a downward correction",
    );
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].correctedBuckets,
      0,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation preserves an ambiguous overlapping multi-file bucket", async () => {
  const install = await makeInflatedInstall();
  try {
    const secondSessionPath = path.join(
      path.dirname(install.sessionPath),
      "session-b.jsonl",
    );
    await fs.writeFile(
      secondSessionPath,
      `${usageLine({
        id: "other-session-event",
        timestamp: "2026-07-07T13:34:00.000Z",
      })}\n`,
      "utf8",
    );
    const secondStat = await fs.stat(secondSessionPath);
    install.cursors.files[secondSessionPath] = {
      inode: secondStat.ino,
      offset: secondStat.size,
    };

    const rows = await readRows(install.queuePath);
    for (const value of rows) {
      const key = `${value.source}|${value.model}|${value.hour_start}`;
      if (key !== install.keys.mainKey) continue;
      value.input_tokens += 200;
      value.cached_input_tokens += 1_000;
      value.cache_creation_input_tokens += 81_071;
      value.output_tokens += 50;
      value.total_tokens += 82_321;
      value.billable_total_tokens += 82_321;
      value.conversation_count += 1;
    }
    await fs.writeFile(
      install.queuePath,
      `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`,
      "utf8",
    );
    const liveTotals =
      install.cursors.hourly.buckets[install.keys.mainKey].totals;
    liveTotals.input_tokens += 200;
    liveTotals.cached_input_tokens += 1_000;
    liveTotals.cache_creation_input_tokens += 81_071;
    liveTotals.output_tokens += 50;
    liveTotals.total_tokens += 82_321;
    liveTotals.billable_total_tokens += 82_321;
    liveTotals.conversation_count += 1;
    const before = { ...liveTotals };

    await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
    });

    assert.deepEqual(
      install.cursors.hourly.buckets[install.keys.mainKey].totals,
      before,
      "a replay delta from only one contributor cannot authorize lowering the shared bucket",
    );
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].correctedBuckets,
      0,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("repairOpenclawRescanInflation tracks a custom OpenClaw home", async () => {
  const install = await makeInflatedInstall({
    openclawDirName: "custom-openclaw",
  });
  try {
    const changed = await repairOpenclawRescanInflation({
      cursors: install.cursors,
      queuePath: install.queuePath,
      queueStatePath: install.queueStatePath,
      openclawRoots: [install.openclawHome],
    });
    assert.equal(changed, true);
    assert.equal(
      install.cursors.hourly.buckets[install.keys.mainKey].totals.total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      install.cursors.migrations[OPENCLAW_RESCAN_REPAIR_KEY].filesRebuilt,
      2,
    );
  } finally {
    await fs.rm(install.home, { recursive: true, force: true });
  }
});

test("a full sync repairs legacy cursors under a custom OpenClaw home without a hook signal", async () => {
    const install = await makeInflatedInstall({
      openclawDirName: "custom-openclaw",
    });
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
      process.env.TOKENTRACKER_OPENCLAW_HOME = install.openclawHome;
      delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
      delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
      delete process.env.TOKENTRACKER_DEVICE_TOKEN;

      await cmdSync([]);

      const persisted = JSON.parse(
        await fs.readFile(path.join(trackerDir, "cursors.json"), "utf8"),
      );
      assert.equal(
        persisted.migrations[OPENCLAW_RESCAN_REPAIR_KEY].status,
        "done",
      );
      assert.equal(
        persisted.hourly.buckets[install.keys.mainKey].totals.total_tokens,
        install.expectedMain.total,
      );
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
    assert.equal(
      latest.get(install.keys.mainKey).total_tokens,
      install.expectedMain.total,
    );
    assert.equal(
      latest.get(install.keys.mainKey).conversation_count,
      install.expectedMain.conversations,
    );
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
