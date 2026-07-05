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
  maskOpenRouterApiKey,
  isValidOpenRouterApiKey,
  getOpenRouterConfigSnapshot,
  saveOpenRouterApiKey,
  clearOpenRouterApiKey,
  probeOpenRouterApiKey,
} = require("../src/lib/openrouter-config");
const { parseOpenRouterApiIncremental } = require("../src/lib/rollout");

const VALID_KEY = "sk-or-v1-abcdefghijklmnopqrst";

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

test("maskOpenRouterApiKey never returns full key", () => {
  const masked = maskOpenRouterApiKey(VALID_KEY);
  assert.ok(masked);
  assert.notEqual(masked, VALID_KEY);
  assert.match(masked, /^sk-or-v1-/);
  assert.doesNotMatch(masked, /abcdefghijklmnopqrst$/);
});

test("isValidOpenRouterApiKey accepts sk-or-v1 format", () => {
  assert.equal(isValidOpenRouterApiKey(VALID_KEY), true);
  assert.equal(isValidOpenRouterApiKey("sk-or-v1-short"), false);
  assert.equal(isValidOpenRouterApiKey("sk-ant-abc"), false);
});

test("getOpenRouterConfigSnapshot reports env override", () => {
  const snapshot = getOpenRouterConfigSnapshot({
    env: { OPENROUTER_API_KEY: VALID_KEY },
    config: { openrouter: { apiKey: "sk-or-v1-configkey123456" } },
  });
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.source, "env");
  assert.equal(snapshot.env_overrides_config, true);
});

test("saveOpenRouterApiKey persists masked snapshot to config.json", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-or-save-"));
  const trackerDir = path.join(tmp, "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "",
  });

  try {
    const result = await saveOpenRouterApiKey({
      apiKey: VALID_KEY,
      trackerDir,
      verify: true,
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.masked_key, maskOpenRouterApiKey(VALID_KEY));

    const raw = await fs.readFile(path.join(trackerDir, "config.json"), "utf8");
    const config = JSON.parse(raw);
    assert.equal(config.openrouter.apiKey, VALID_KEY);
    assert.equal(typeof config.openrouter.configuredAt, "string");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("clearOpenRouterApiKey removes openrouter block", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-or-clear-"));
  const trackerDir = path.join(tmp, "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  const configPath = path.join(trackerDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ openrouter: { apiKey: VALID_KEY } }, null, 2),
    "utf8",
  );

  try {
    const result = await clearOpenRouterApiKey({ trackerDir });
    assert.equal(result.cleared, true);
    assert.equal(result.snapshot.configured, false);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(config.openrouter, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("probeOpenRouterApiKey maps auth failures", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
  });
  const result = await probeOpenRouterApiKey(VALID_KEY, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid|analytics/i);
});
