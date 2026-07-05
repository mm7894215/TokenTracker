const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseOpenRouterAnalyticsRows,
  normalizeOpenRouterUsage,
  resolveOpenRouterApiKey,
  isOpenRouterConfigured,
  resolveOpenRouterDayKey,
} = require("../src/lib/openrouter-config");
const { parseOpenRouterApiIncremental } = require("../src/lib/rollout");

test("parseOpenRouterAnalyticsRows maps daily analytics rows to records", () => {
  const records = parseOpenRouterAnalyticsRows({
    data: {
      data: [
        {
          date__day: "2026-07-01",
          model: "anthropic/claude-sonnet-4",
          tokens_input: 1200,
          tokens_output: 300,
          tokens_total: 1500,
        },
        {
          created_at__day: "2026-07-02",
          model: "openai/gpt-4.1",
          tokens_input: 0,
          tokens_output: 0,
          tokens_total: 0,
        },
      ],
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].date, "2026-07-01T12:00:00.000Z");
  assert.equal(records[0].model, "anthropic/claude-sonnet-4");
  assert.equal(records[0].inputTokens, 1200);
  assert.equal(records[0].outputTokens, 300);
  assert.equal(records[0].totalTokens, 1500);
});

test("normalizeOpenRouterUsage returns canonical token shape", () => {
  assert.deepEqual(
    normalizeOpenRouterUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }),
    {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 15,
      billable_total_tokens: 15,
    },
  );
});

test("resolveOpenRouterApiKey prefers env over config", () => {
  assert.equal(
    resolveOpenRouterApiKey({
      env: { OPENROUTER_API_KEY: "sk-or-env" },
      config: { openrouter: { apiKey: "sk-or-config" } },
    }),
    "sk-or-env",
  );
  assert.equal(
    resolveOpenRouterApiKey({
      env: {},
      config: { openrouter: { apiKey: "sk-or-config" } },
    }),
    "sk-or-config",
  );
  assert.equal(resolveOpenRouterApiKey({ env: {}, config: {} }), null);
  assert.equal(isOpenRouterConfigured({ env: { OPENROUTER_API_KEY: "x" } }), true);
});

test("resolveOpenRouterDayKey accepts date__day and created_at__day", () => {
  assert.equal(resolveOpenRouterDayKey({ date__day: "2026-07-03" }), "2026-07-03");
  assert.equal(resolveOpenRouterDayKey({ created_at__day: "2026-07-04" }), "2026-07-04");
  assert.equal(resolveOpenRouterDayKey({}), null);
});

test("parseOpenRouterApiIncremental queues openrouter buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openrouter-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const result = await parseOpenRouterApiIncremental({
      records: [
        {
          date: "2026-07-01T12:00:00.000Z",
          model: "anthropic/claude-sonnet-4",
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
        },
      ],
      cursors,
      queuePath,
      source: "openrouter",
    });

    assert.equal(result.eventsAggregated, 1);
    const raw = await fs.readFile(queuePath, "utf8");
    assert.match(raw, /"source":"openrouter"/);
    assert.match(raw, /"total_tokens":125/);
    assert.equal(
      cursors.hourly.buckets["openrouter|anthropic/claude-sonnet-4|2026-07-01T12:00:00.000Z"].totals
        .total_tokens,
      125,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
