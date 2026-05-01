const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  migrateCursorUnknownBuckets,
  migrateRolloutCumulativeDeltaBuckets,
  CURSOR_UNKNOWN_MIGRATION_KEY,
  ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY,
} = require("../src/commands/sync");

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-mig-"));
}

describe("migrateCursorUnknownBuckets", () => {
  it("purges cursor|unknown buckets, emits zero retractions, resets cursorApi", async () => {
    const dir = await makeTempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {
      hourly: {
        buckets: {
          "cursor|unknown|2026-04-13T05:30:00.000Z": {
            totals: { total_tokens: 58396, conversation_count: 2 },
          },
          "cursor|unknown|2026-04-14T10:00:00.000Z": {
            totals: { total_tokens: 234247, conversation_count: 7 },
          },
          "cursor|composer-2-fast|2026-04-14T10:00:00.000Z": {
            totals: { total_tokens: 123, conversation_count: 1 },
          },
          "codex|unknown|2026-04-14T10:00:00.000Z": {
            totals: { total_tokens: 456, conversation_count: 1 },
          },
        },
      },
      cursorApi: { lastRecordTimestamp: "2026-04-16T03:32:33.284Z" },
    };

    await migrateCursorUnknownBuckets({ cursors, queuePath });

    assert.equal(cursors.hourly.buckets["cursor|unknown|2026-04-13T05:30:00.000Z"], undefined);
    assert.equal(cursors.hourly.buckets["cursor|unknown|2026-04-14T10:00:00.000Z"], undefined);
    assert.ok(cursors.hourly.buckets["cursor|composer-2-fast|2026-04-14T10:00:00.000Z"]);
    assert.ok(cursors.hourly.buckets["codex|unknown|2026-04-14T10:00:00.000Z"]);
    assert.equal(cursors.cursorApi.lastRecordTimestamp, null);
    assert.ok(cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY]);

    const queueText = await fs.readFile(queuePath, "utf8");
    const lines = queueText.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.equal(row.source, "cursor");
      assert.equal(row.model, "unknown");
      assert.equal(row.total_tokens, 0);
      assert.equal(row.conversation_count, 0);
    }

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is idempotent — second call is a no-op", async () => {
    const dir = await makeTempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {
      hourly: { buckets: { "cursor|unknown|2026-04-13T05:30:00.000Z": { totals: {} } } },
      cursorApi: { lastRecordTimestamp: "x" },
    };
    await migrateCursorUnknownBuckets({ cursors, queuePath });
    const firstSize = fssync.statSync(queuePath).size;

    // Re-add a fresh unknown bucket post-migration; the marker must prevent re-purge.
    cursors.hourly.buckets["cursor|unknown|2026-04-20T00:00:00.000Z"] = { totals: {} };
    await migrateCursorUnknownBuckets({ cursors, queuePath });

    const secondSize = fssync.statSync(queuePath).size;
    assert.equal(secondSize, firstSize);
    assert.ok(cursors.hourly.buckets["cursor|unknown|2026-04-20T00:00:00.000Z"]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("no-op and still records marker when there are no unknown buckets", async () => {
    const dir = await makeTempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {
      hourly: { buckets: { "cursor|composer-2-fast|2026-04-14T10:00:00.000Z": { totals: {} } } },
      cursorApi: { lastRecordTimestamp: "2026-04-16T03:32:33.284Z" },
    };
    await migrateCursorUnknownBuckets({ cursors, queuePath });
    assert.equal(fssync.existsSync(queuePath), false);
    assert.equal(cursors.cursorApi.lastRecordTimestamp, "2026-04-16T03:32:33.284Z");
    assert.ok(cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("migrateRolloutCumulativeDeltaBuckets", () => {
  it("purges codex and every-code buckets, emits zero retractions, and resets rollout file cursors", async () => {
    const dir = await makeTempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const codexPath = path.join(dir, ".codex", "sessions", "rollout-codex.jsonl");
    const everyCodePath = path.join(dir, ".code", "sessions", "rollout-every.jsonl");
    const claudePath = path.join(dir, ".claude", "projects", "session.jsonl");
    const cursors = {
      files: {
        [codexPath]: { offset: 100 },
        [everyCodePath]: { offset: 200 },
        [claudePath]: { offset: 300 },
      },
      hourly: {
        groupQueued: {
          "codex|2026-05-01T00:00:00.000Z": "old-codex",
          "every-code|2026-05-01T00:30:00.000Z": "old-every",
          "claude|2026-05-01T00:00:00.000Z": "old-claude",
        },
        buckets: {
          "codex|gpt-5.5|2026-05-01T00:00:00.000Z": {
            totals: { total_tokens: 100, conversation_count: 2 },
          },
          "every-code|gpt-5.5|2026-05-01T00:30:00.000Z": {
            totals: { total_tokens: 50, conversation_count: 1 },
          },
          "claude|opus|2026-05-01T00:00:00.000Z": {
            totals: { total_tokens: 25, conversation_count: 1 },
          },
        },
      },
    };

    await migrateRolloutCumulativeDeltaBuckets({
      cursors,
      queuePath,
      rolloutFiles: [
        { path: codexPath, source: "codex" },
        { path: everyCodePath, source: "every-code" },
      ],
    });

    assert.equal(cursors.files[codexPath], undefined);
    assert.equal(cursors.files[everyCodePath], undefined);
    assert.equal(cursors.files[claudePath].offset, 300);
    assert.equal(cursors.hourly.buckets["codex|gpt-5.5|2026-05-01T00:00:00.000Z"], undefined);
    assert.equal(cursors.hourly.buckets["every-code|gpt-5.5|2026-05-01T00:30:00.000Z"], undefined);
    assert.ok(cursors.hourly.buckets["claude|opus|2026-05-01T00:00:00.000Z"]);
    assert.equal(cursors.hourly.groupQueued["codex|2026-05-01T00:00:00.000Z"], undefined);
    assert.equal(cursors.hourly.groupQueued["every-code|2026-05-01T00:30:00.000Z"], undefined);
    assert.equal(cursors.hourly.groupQueued["claude|2026-05-01T00:00:00.000Z"], "old-claude");
    assert.ok(cursors.migrations[ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY]);

    const rows = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => `${row.source}|${row.model}|${row.total_tokens}`).sort(),
      ["codex|gpt-5.5|0", "every-code|gpt-5.5|0"],
    );

    await fs.rm(dir, { recursive: true, force: true });
  });
});
