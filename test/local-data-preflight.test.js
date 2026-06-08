const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  buildServeDataPreflightMessage,
  summarizeQueueData,
} = require("../src/lib/local-data-preflight");

test("summarizeQueueData dedupes buckets and totals token rows", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-preflight-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await fs.writeFile(
      queuePath,
      [
        JSON.stringify({ source: "codex", model: "gpt-5", hour_start: "2026-06-05T01:00:00.000Z", total_tokens: 100 }),
        JSON.stringify({ source: "codex", model: "gpt-5", hour_start: "2026-06-05T01:00:00.000Z", total_tokens: 125 }),
        JSON.stringify({ source: "claude", model: "sonnet", hour_start: "2026-06-05T02:00:00.000Z", total_tokens: 75 }),
        "{bad",
      ].join("\n") + "\n",
      "utf8",
    );

    const summary = await summarizeQueueData(queuePath);

    assert.equal(summary.lineCount, 4);
    assert.equal(summary.malformedLines, 1);
    assert.equal(summary.bucketCount, 2);
    assert.equal(summary.totalTokens, 200);
    assert.deepEqual(summary.sources, ["claude", "codex"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("buildServeDataPreflightMessage warns when sync found no local token data", () => {
  const result = buildServeDataPreflightMessage({
    queueSummary: { lineCount: 0, bucketCount: 0, totalTokens: 0, sources: [] },
    syncSummary: { totalParsed: 0, totalBuckets: 0 },
  });

  assert.equal(result.status, "warn");
  assert.match(result.message, /no local token data was found after sync/);
  assert.match(result.message, /tokentracker status --light/);
});

test("buildServeDataPreflightMessage reports ok when queue has token data", () => {
  const result = buildServeDataPreflightMessage({
    queueSummary: { bucketCount: 2, totalTokens: 1234, sources: ["codex"] },
    syncSummary: { totalParsed: 0, totalBuckets: 0 },
  });

  assert.equal(result.status, "ok");
  assert.match(result.message, /1,234 tokens/);
});
