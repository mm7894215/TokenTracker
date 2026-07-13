"use strict";

const assert = require("node:assert/strict");
const fssync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  openclawCursorKey,
  parseOpenclawIncremental,
  parseRolloutIncremental,
} = require("../src/lib/rollout");
const { mockMethod } = require("./helpers/mock");

function usageLine({ id, timestamp, model = "claude-opus-4.7" }) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      model,
      usage: {
        input: 1_200,
        cacheRead: 1_000,
        cacheWrite: 81_071,
        output: 50,
        totalTokens: 82_321,
      },
    },
  });
}

async function writeLines(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function replaceLines(filePath, lines) {
  const replacement = `${filePath}.replacement`;
  await writeLines(replacement, lines);
  await fs.rename(replacement, filePath);
}

async function appendPrivateFixture(filePath, content) {
  await fs.appendFile(filePath, content, "utf8");
}

function openclawCursor(cursors, filePath) {
  return cursors.files[openclawCursorKey(filePath)];
}

test("parseOpenclawIncremental counts only the new event after an atomic session rewrite", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });

    await writeLines(sessionPath, [firstLine]);
    const firstInode = (await fs.stat(sessionPath)).ino;
    const first = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(first.eventsAggregated, 1);

    await replaceLines(sessionPath, [firstLine, secondLine]);
    const secondInode = (await fs.stat(sessionPath)).ino;
    assert.notEqual(secondInode, firstInode, "fixture must simulate an inode-changing rewrite");

    const second = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);

    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.cache_creation_input_tokens, 162_142);
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental skips a missing file without discarding present files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const missingPath = path.join(tmp, "missing.jsonl");
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await writeLines(sessionPath, [
      usageLine({
        id: "event-1",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    ]);

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [missingPath, sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(parsed.filesProcessed, 1);
    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(openclawCursor(cursors, missingPath), undefined);
    assert.equal(
      openclawCursor(cursors, sessionPath).offset,
      (await fs.stat(sessionPath)).size,
    );
    const rows = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversation_count, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental keeps the append-only fast path", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realCreateReadStream = fssync.createReadStream.bind(fssync);
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });

    await writeLines(sessionPath, [firstLine]);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    const inode = openclawCursor(cursors, sessionPath).inode;
    const offset = openclawCursor(cursors, sessionPath).offset;
    const scannedRanges = [];
    mockMethod(t, fssync, "createReadStream", (...args) => {
      scannedRanges.push({
        start: args[1]?.start,
        end: args[1]?.end,
      });
      return realCreateReadStream(...args);
    });

    await fs.appendFile(sessionPath, `${secondLine}\n`, "utf8");
    const second = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(second.eventsAggregated, 1);
    assert.equal(openclawCursor(cursors, sessionPath).inode, inode);
    assert.ok(openclawCursor(cursors, sessionPath).offset > offset);
    assert.deepEqual(
      scannedRanges,
      [
        { start: 0, end: offset - 1 },
        {
          start: offset,
          end: openclawCursor(cursors, sessionPath).offset - 1,
        },
      ],
      "routine appends should verify the prior prefix once and extend its fingerprint with the tail",
    );
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental commits cursors only after queue append succeeds", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realAppendFile = fs.appendFile.bind(fs);
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {},
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
        updatedAt: null,
      },
      updatedAt: null,
    };
    const before = structuredClone(cursors);
    await writeLines(sessionPath, [
      usageLine({
        id: "event-1",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    ]);
    let failQueueAppend = true;
    mockMethod(t, fs, "appendFile", async (filePath, ...args) => {
      if (
        failQueueAppend &&
        path.resolve(String(filePath)) === path.resolve(queuePath)
      ) {
        failQueueAppend = false;
        throw new Error("injected queue append failure");
      }
      return realAppendFile(filePath, ...args);
    });

    await assert.rejects(
      parseOpenclawIncremental({
        sessionFiles: [sessionPath],
        cursors,
        queuePath,
      }),
      /injected queue append failure/,
    );
    assert.deepEqual(cursors, before);

    const retried = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(retried.eventsAggregated, 1);
    const rows = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversation_count, 2);
    assert.equal(openclawCursor(cursors, sessionPath).offset, (await fs.stat(sessionPath)).size);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental preserves repeated identical metadata events with multiset dedup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const identicalLine = usageLine({
      timestamp: "2026-07-07T13:31:00.000Z",
    });

    await writeLines(sessionPath, [identicalLine, identicalLine]);
    const first = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(first.eventsAggregated, 2);

    await replaceLines(sessionPath, [identicalLine, identicalLine, identicalLine]);
    const second = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);

    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 3);
    assert.equal(bucket.totals.cache_creation_input_tokens, 243_213);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental deduplicates stable IDs after same-inode compaction", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstLines = ["event-1", "event-2", "event-3"].map((id, index) =>
      usageLine({
        id,
        timestamp: `2026-07-07T13:3${index + 1}:00.000Z`,
      }),
    );

    await writeLines(sessionPath, firstLines);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    const inode = (await fs.stat(sessionPath)).ino;

    const compactedLines = [
      firstLines[2],
      usageLine({
        id: "event-4",
        timestamp: "2026-07-07T13:34:00.000Z",
      }),
    ];
    await writeLines(sessionPath, compactedLines);
    assert.equal((await fs.stat(sessionPath)).ino, inode, "fixture must preserve the inode");

    const compacted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(compacted.eventsAggregated, 1);
    assert.equal(
      Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length,
      4,
      "exact dedup must retain identities that a later rewrite could restore",
    );

    await replaceLines(sessionPath, [
      ...compactedLines,
      usageLine({
        id: "event-5",
        timestamp: "2026-07-07T13:35:00.000Z",
      }),
    ]);
    const rewritten = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(
      rewritten.eventsAggregated,
      1,
      "the next rewrite must retain dedup for compacted events",
    );
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental handles atomic rewrites when the persisted inode is zero", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });

    await writeLines(sessionPath, [firstLine]);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    openclawCursor(cursors, sessionPath).inode = 0;
    assert.equal(openclawCursor(cursors, sessionPath).inode, 0);

    await replaceLines(sessionPath, [secondLine]);
    const second = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 1);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental fingerprints same-inode same-size and larger rewrites", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const event1 = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const event2 = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    const event3 = usageLine({
      id: "event-3",
      timestamp: "2026-07-07T13:33:00.000Z",
    });

    await writeLines(sessionPath, [event1, event2]);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    const inode = (await fs.stat(sessionPath)).ino;
    const priorOffset = openclawCursor(cursors, sessionPath).offset;
    assert.equal(openclawCursor(cursors, sessionPath).usageFingerprint?.version, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        openclawCursor(cursors, sessionPath),
        "prefixHash",
      ),
      false,
      "cursor fingerprints must never hash raw JSONL bytes",
    );

    await writeLines(sessionPath, [event1, event3]);
    assert.equal((await fs.stat(sessionPath)).ino, inode);
    assert.equal((await fs.stat(sessionPath)).size, priorOffset);
    const sameSize = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(sameSize.eventsAggregated, 1);

    const longEvent4 = usageLine({
      id: "event-4-with-a-longer-id-that-crosses-the-old-offset",
      timestamp: "2026-07-07T13:34:00.000Z",
    });
    const event5 = usageLine({
      id: "event-5",
      timestamp: "2026-07-07T13:35:00.000Z",
    });
    await writeLines(sessionPath, [event1, longEvent4, event5]);
    assert.equal((await fs.stat(sessionPath)).ino, inode);
    assert.ok(
      event1.length < priorOffset && event1.length + longEvent4.length > priorOffset,
      "the old offset must land inside rewritten JSON",
    );
    const larger = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(larger.eventsAggregated, 2);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 5);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental ignores prompt-only rewrites when verifying the usage prefix", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const first = JSON.parse(
      usageLine({
        id: "event-1",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    );
    first.message.content = "private prompt-shaped content A";
    await writeLines(sessionPath, [JSON.stringify(first)]);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    first.message.content = "different private prompt-shaped content B";
    const second = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await replaceLines(sessionPath, [JSON.stringify(first), second]);
    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(openclawCursor(cursors, sessionPath).usageFingerprint.eventCount, 2);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        openclawCursor(cursors, sessionPath),
        "prefixHash",
      ),
      false,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental retries an atomic replacement that lands during parsing", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realCreateReadStream = fssync.createReadStream.bind(fssync);
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const replacementPath = path.join(tmp, "replacement.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const first = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const second = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [first]);
    await writeLines(replacementPath, [first, second]);

    let replaced = false;
    mockMethod(t, fssync, "createReadStream", (...args) => {
      const stream = realCreateReadStream(...args);
      if (!replaced) {
        replaced = true;
        if (process.platform === "win32") {
          fssync.copyFileSync(replacementPath, sessionPath);
        } else {
          fssync.renameSync(replacementPath, sessionPath);
        }
      }
      return stream;
    });

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(parsed.eventsAggregated, 2);
    assert.equal(openclawCursor(cursors, sessionPath).usageFingerprint.eventCount, 2);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental counts duplicate stable IDs once per scan", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const duplicate = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    await writeLines(sessionPath, [duplicate, duplicate]);

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(parsed.eventsAggregated, 1);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 1);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental does not consume stable IDs from invalid usage records", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const zeroUsage = JSON.parse(
      usageLine({
        id: "event-zero",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    );
    zeroUsage.message.usage = {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      totalTokens: 0,
    };
    const invalidTimestamp = JSON.parse(
      usageLine({
        id: "event-invalid-time",
        timestamp: "not-a-timestamp",
      }),
    );
    await writeLines(sessionPath, [
      JSON.stringify(zeroUsage),
      JSON.stringify(invalidTimestamp),
    ]);

    const invalid = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(invalid.eventsAggregated, 0);
    assert.deepEqual(openclawCursor(cursors, sessionPath).usageEvents, {});

    const validZeroId = usageLine({
      id: "event-zero",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const validTimestampId = usageLine({
      id: "event-invalid-time",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await replaceLines(sessionPath, [validZeroId, validTimestampId]);
    const repaired = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repaired.eventsAggregated, 2);

    await replaceLines(sessionPath, [validZeroId, validTimestampId]);
    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental rejects malformed token fields before consuming stable IDs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const badCacheRead = JSON.parse(
      usageLine({
        id: "event-bad-cache-read",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    );
    badCacheRead.message.usage.cacheRead = "bad";
    const negativeCacheWrite = JSON.parse(
      usageLine({
        id: "event-negative-cache-write",
        timestamp: "2026-07-07T13:32:00.000Z",
      }),
    );
    negativeCacheWrite.message.usage.cacheWrite = -1;
    const infiniteTotal = usageLine({
      id: "event-infinite-total",
      timestamp: "2026-07-07T13:33:00.000Z",
    }).replace('"totalTokens":82321', '"totalTokens":1e999');
    await writeLines(sessionPath, [
      JSON.stringify(badCacheRead),
      JSON.stringify(negativeCacheWrite),
      infiniteTotal,
    ]);

    const invalid = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(invalid.eventsAggregated, 0);
    assert.deepEqual(openclawCursor(cursors, sessionPath).usageEvents, {});

    const corrected = [
      usageLine({
        id: "event-bad-cache-read",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
      usageLine({
        id: "event-negative-cache-write",
        timestamp: "2026-07-07T13:32:00.000Z",
      }),
      usageLine({
        id: "event-infinite-total",
        timestamp: "2026-07-07T13:33:00.000Z",
      }),
    ];
    await replaceLines(sessionPath, corrected);
    const valid = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(valid.eventsAggregated, 3);

    await replaceLines(sessionPath, corrected);
    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      3,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental rejects coercible non-number token fields", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const malformedCases = [
      ["input", false],
      ["cacheRead", null],
      ["cacheWrite", []],
      ["output", {}],
      ["totalTokens", "123"],
    ];
    const malformed = malformedCases.map(([field, value], index) => {
      const record = JSON.parse(
        usageLine({
          id: `event-coercible-${index}`,
          timestamp: `2026-07-07T13:${31 + index}:00.000Z`,
        }),
      );
      record.message.usage[field] = value;
      return JSON.stringify(record);
    });
    await writeLines(sessionPath, malformed);

    const invalid = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(invalid.eventsAggregated, 0);
    assert.deepEqual(openclawCursor(cursors, sessionPath).usageEvents, {});

    const corrected = malformedCases.map((_, index) =>
      usageLine({
        id: `event-coercible-${index}`,
        timestamp: `2026-07-07T13:${31 + index}:00.000Z`,
      }),
    );
    await replaceLines(sessionPath, corrected);
    const valid = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(valid.eventsAggregated, malformedCases.length);

    await replaceLines(sessionPath, corrected);
    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      malformedCases.length,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("OpenClaw cursor keys normalize Windows separators and casing", () => {
  const canonical =
    "c:/users/alice/.openclaw/agents/claude/sessions/session-a.jsonl";
  assert.equal(
    openclawCursorKey(
      "C:\\Users\\Alice\\.OpenClaw\\agents\\Claude\\sessions\\Session-A.jsonl",
    ),
    canonical,
  );
  assert.equal(
    openclawCursorKey(
      "c:/users/alice/.openclaw/agents/claude/sessions/session-a.jsonl",
    ),
    canonical,
  );
});

test("parseOpenclawIncremental resumes append-only files that previously had no usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await writeLines(sessionPath, [
      JSON.stringify({
        type: "session",
        id: "session-a",
        timestamp: "2026-07-07T13:30:00.000Z",
      }),
    ]);
    await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.deepEqual(openclawCursor(cursors, sessionPath).usageEvents, {});
    const offset = openclawCursor(cursors, sessionPath).offset;

    await fs.appendFile(
      sessionPath,
      `${usageLine({
        id: "event-1",
        timestamp: "2026-07-07T13:31:00.000Z",
      })}\n`,
      "utf8",
    );
    const appended = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(appended.eventsAggregated, 1);
    assert.ok(openclawCursor(cursors, sessionPath).offset > offset);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental adopts a legacy offset cursor without replaying history", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine]);
    const stat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: stat.ino,
          offset: stat.size,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(adopted.eventsAggregated, 0);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 1);
    assert.equal(openclawCursor(cursors, sessionPath).usageFingerprint?.version, 1);

    await replaceLines(sessionPath, [firstLine, secondLine]);
    const rewritten = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(rewritten.eventsAggregated, 1);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental seeds legacy stable IDs before parsing the tail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine]);
    const stat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: stat.ino,
          offset: stat.size,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };
    await appendPrivateFixture(sessionPath, `${firstLine}\n${secondLine}\n`);

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental preserves legacy metadata multiset occurrences in a full scan", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const withoutStableId = JSON.parse(
      usageLine({
        id: "removed",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    );
    delete withoutStableId.id;
    const identicalLine = JSON.stringify(withoutStableId);
    await writeLines(sessionPath, [identicalLine]);
    const stat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: stat.ino,
          offset: stat.size,
          updatedAt: "2026-07-07T13:30:00.000Z",
        },
      },
      hourly: { version: 3, buckets: {}, groupQueued: {} },
    };
    await appendPrivateFixture(sessionPath, `${identicalLine}\n`);

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(parsed.eventsAggregated, 2);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );
    assert.deepEqual(
      Object.values(openclawCursor(cursors, sessionPath).usageEvents),
      [2],
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental resumes a completed legacy partial line on the same inode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    const splitOffset = Math.floor(Buffer.byteLength(firstLine) / 2);
    await fs.writeFile(sessionPath, firstLine.slice(0, splitOffset), "utf8");
    const partialStat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: partialStat.ino,
          offset: partialStat.size,
          updatedAt: "2026-07-07T13:30:00.000Z",
        },
      },
      hourly: { version: 3, buckets: {}, groupQueued: {} },
    };

    await appendPrivateFixture(
      sessionPath,
      `${firstLine.slice(splitOffset)}\n${secondLine}\n`,
    );
    assert.equal(
      (await fs.stat(sessionPath)).ino,
      partialStat.ino,
      "fixture must complete the partial line on the same inode",
    );

    const completed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(completed.eventsAggregated, 2);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);

    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
    assert.equal(bucket.totals.conversation_count, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental does not replay a counted legacy line that lacked a newline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await fs.writeFile(sessionPath, firstLine, "utf8");
    const firstStat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: firstStat.ino,
          offset: firstStat.size,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };

    await appendPrivateFixture(sessionPath, `\n${secondLine}\n`);
    assert.equal((await fs.stat(sessionPath)).ino, firstStat.ino);
    const appended = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(appended.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);

    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental baselines a changed-inode legacy rewrite whose offset is mid-line", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    const midLineOffset = Math.floor(Buffer.byteLength(firstLine) / 2);
    await fs.writeFile(sessionPath, firstLine.slice(0, midLineOffset), "utf8");
    const oldStat = await fs.stat(sessionPath);
    await replaceLines(sessionPath, [firstLine, secondLine]);
    const stat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode:
            oldStat.ino > 0 && oldStat.ino !== stat.ino
              ? oldStat.ino
              : Number(stat.ino || 0) + 1,
          offset: midLineOffset,
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 400,
              cached_input_tokens: 2_000,
              cache_creation_input_tokens: 162_142,
              output_tokens: 100,
              reasoning_output_tokens: 0,
              total_tokens: 164_642,
              billable_total_tokens: 164_642,
              conversation_count: 2,
            },
          },
        },
        groupQueued: {},
      },
    };

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(adopted.eventsAggregated, 0);
    assert.equal(openclawCursor(cursors, sessionPath).offset, stat.size);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );

    await appendPrivateFixture(
      sessionPath,
      `${usageLine({
        id: "event-3",
        timestamp: "2026-07-07T13:33:00.000Z",
      })}\n`,
    );
    const appended = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(appended.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      3,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental baselines a changed-inode legacy rewrite at a line boundary", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine]);
    const oldStat = await fs.stat(sessionPath);
    const previousOffset = oldStat.size;
    await replaceLines(sessionPath, [firstLine, secondLine]);
    const currentStat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode:
            oldStat.ino > 0 && oldStat.ino !== currentStat.ino
              ? oldStat.ino
              : Number(currentStat.ino || 0) + 1,
          offset: previousOffset,
          updatedAt: "not-a-date",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 400,
              cached_input_tokens: 2_000,
              cache_creation_input_tokens: 162_142,
              output_tokens: 100,
              reasoning_output_tokens: 0,
              total_tokens: 164_642,
              billable_total_tokens: 164_642,
              conversation_count: 2,
            },
          },
        },
        groupQueued: {},
      },
    };

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(adopted.eventsAggregated, 0);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);

    await appendPrivateFixture(
      sessionPath,
      `${usageLine({
        id: "event-3",
        timestamp: "2026-07-07T13:33:00.000Z",
      })}\n`,
    );
    const appended = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(appended.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      3,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental counts only post-cutoff usage for a changed-inode legacy cursor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-before-cutoff",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-after-cutoff",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine]);
    const oldStat = await fs.stat(sessionPath);
    const previousOffset = oldStat.size;
    await replaceLines(sessionPath, [firstLine, secondLine]);
    const currentStat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode:
            oldStat.ino > 0 && oldStat.ino !== currentStat.ino
              ? oldStat.ino
              : Number(currentStat.ino || 0) + 1,
          offset: previousOffset,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );

    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental counts a post-cutoff event moved before a legacy offset", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const oldLine = usageLine({
      id: "event-a",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const newLine = usageLine({
      id: "event-b",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [oldLine]);
    const oldStat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: oldStat.ino,
          offset: oldStat.size,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };
    await writeLines(sessionPath, [newLine, oldLine]);
    assert.equal((await fs.stat(sessionPath)).ino, oldStat.ino);
    assert.ok(
      Buffer.byteLength(`${newLine}\n`) <= oldStat.size,
      "new event must move before the old cursor offset",
    );

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental baselines a zero-inode legacy cursor at a line boundary", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine, secondLine]);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: 0,
          offset: Buffer.byteLength(`${firstLine}\n`),
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 400,
              cached_input_tokens: 2_000,
              cache_creation_input_tokens: 162_142,
              output_tokens: 100,
              reasoning_output_tokens: 0,
              total_tokens: 164_642,
              billable_total_tokens: 164_642,
              conversation_count: 2,
            },
          },
        },
        groupQueued: {},
      },
    };

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(adopted.eventsAggregated, 0);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);

    await fs.appendFile(
      sessionPath,
      `${usageLine({
        id: "event-3",
        timestamp: "2026-07-07T13:33:00.000Z",
      })}\n`,
      "utf8",
    );
    const appended = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(appended.eventsAggregated, 1);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      3,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental counts only post-cutoff usage for a zero-inode legacy cursor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-before-cutoff",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-after-cutoff",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine, secondLine]);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: 0,
          offset: Buffer.byteLength(`${firstLine}\n`),
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };

    const parsed = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(parsed.eventsAggregated, 1);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
    assert.equal(
      cursors.hourly.buckets[
        "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
      ].totals.conversation_count,
      2,
    );

    const repeated = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(repeated.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental migrates a legacy fingerprint with one full scan", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realCreateReadStream = fssync.createReadStream.bind(fssync);
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const firstLine = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const secondLine = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [firstLine, secondLine]);
    const stat = await fs.stat(sessionPath);
    const previousOffset = Buffer.byteLength(`${firstLine}\n`);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: stat.ino,
          offset: previousOffset,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };
    const scannedRanges = [];
    mockMethod(t, fssync, "createReadStream", (...args) => {
      scannedRanges.push({
        start: args[1]?.start,
        end: args[1]?.end,
      });
      return realCreateReadStream(...args);
    });

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(adopted.eventsAggregated, 1);
    assert.deepEqual(scannedRanges, [
      { start: 0, end: stat.size - 1 },
    ]);
    assert.equal(openclawCursor(cursors, sessionPath).usageFingerprint.eventCount, 2);
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental counts a concurrent post-cutoff event during legacy migration", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realCreateReadStream = fssync.createReadStream.bind(fssync);
  try {
    const sessionPath = path.join(tmp, "session.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const first = usageLine({
      id: "event-1",
      timestamp: "2026-07-07T13:31:00.000Z",
    });
    const second = usageLine({
      id: "event-2",
      timestamp: "2026-07-07T13:32:00.000Z",
    });
    await writeLines(sessionPath, [first]);
    const stat = await fs.stat(sessionPath);
    const cursors = {
      version: 1,
      files: {
        [openclawCursorKey(sessionPath)]: {
          inode: stat.ino,
          offset: stat.size,
          updatedAt: "2026-07-07T13:31:30.000Z",
        },
      },
      hourly: {
        version: 3,
        buckets: {
          "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z": {
            totals: {
              input_tokens: 200,
              cached_input_tokens: 1_000,
              cache_creation_input_tokens: 81_071,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 82_321,
              billable_total_tokens: 82_321,
              conversation_count: 1,
            },
          },
        },
        groupQueued: {},
      },
    };

    let appended = false;
    mockMethod(t, fssync, "createReadStream", (...args) => {
      const stream = realCreateReadStream(...args);
      if (!appended) {
        appended = true;
        fssync.appendFileSync(sessionPath, `${second}\n`, "utf8");
      }
      return stream;
    });

    const adopted = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(
      adopted.eventsAggregated,
      1,
      "a generation retry must count the concurrently appended event",
    );
    assert.equal(Object.keys(openclawCursor(cursors, sessionPath).usageEvents).length, 2);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);

    await replaceLines(sessionPath, [first, second]);
    const rewritten = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });
    assert.equal(rewritten.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("OpenClaw cursor ownership does not claim Codex rollout files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-test.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeLines(rolloutPath, [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-07T13:31:00.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 150,
            },
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 150,
            },
          },
        },
      }),
    ]);
    const cursors = { version: 1, files: {} };

    await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "codex" }],
      cursors,
      queuePath,
    });
    assert.notEqual(cursors.files[rolloutPath].provider, "openclaw");

    const openclawPath = path.join(tmp, "openclaw.jsonl");
    await writeLines(openclawPath, [
      usageLine({
        id: "event-1",
        timestamp: "2026-07-07T13:31:00.000Z",
      }),
    ]);
    await parseOpenclawIncremental({
      sessionFiles: [openclawPath],
      cursors,
      queuePath,
    });
    assert.equal(openclawCursor(cursors, openclawPath).provider, "openclaw");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
