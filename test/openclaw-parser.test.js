"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  openclawCursorKey,
  parseOpenclawIncremental,
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

test("parseOpenclawIncremental keeps the append-only fast path", async () => {
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
    const inode = cursors.files[sessionPath].inode;
    const offset = cursors.files[sessionPath].offset;

    await fs.appendFile(sessionPath, `${secondLine}\n`, "utf8");
    const second = await parseOpenclawIncremental({
      sessionFiles: [sessionPath],
      cursors,
      queuePath,
    });

    assert.equal(second.eventsAggregated, 1);
    assert.equal(cursors.files[sessionPath].inode, inode);
    assert.ok(cursors.files[sessionPath].offset > offset);
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 2);
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
    const bucket = cursors.hourly.buckets[
      "openclaw|claude-opus-4.7|2026-07-07T13:30:00.000Z"
    ];
    assert.equal(bucket.totals.conversation_count, 4);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOpenclawIncremental handles atomic rewrites when inode reporting is always zero", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-"));
  const realStat = fs.stat.bind(fs);
  mockMethod(t, fs, "stat", async (...args) => {
    const stat = await realStat(...args);
    return {
      ...stat,
      ino: 0,
      isFile: () => stat.isFile(),
    };
  });
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
    assert.equal(cursors.files[sessionPath].inode, 0);

    await replaceLines(sessionPath, [firstLine, secondLine]);
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
    assert.deepEqual(cursors.files[sessionPath].usageEvents, {});
    const offset = cursors.files[sessionPath].offset;

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
    assert.ok(cursors.files[sessionPath].offset > offset);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
