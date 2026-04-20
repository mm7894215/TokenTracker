const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

// ─────────────────────────────────────────────────────────────────────────────
// Local-api handler under test — only loaded when the pricing / consumer-
// boundary tests below need it; kept lazy so module-load cost isn't paid
// by the existing dashboard-only tests.
// ─────────────────────────────────────────────────────────────────────────────
const localApi = require("../src/lib/local-api");
const leaderboardRefreshPath = path.resolve(
  __dirname,
  "../dashboard/edge-patches/tokentracker-leaderboard-refresh.ts",
);

test("buildFleetData keeps usage tokens for fleet rows", async () => {
  const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
  const buildFleetData = mod.buildFleetData;

  const modelBreakdown = {
    pricing: { pricing_mode: "list" },
    sources: [
      {
        source: "cli",
        totals: { total_tokens: 1200, total_cost_usd: 1.2 },
        models: [
          {
            model: "gpt-4o",
            model_id: "gpt-4o",
            totals: { total_tokens: 1200 },
          },
        ],
      },
      {
        source: "api",
        totals: { total_tokens: 0, total_cost_usd: 0 },
        models: [],
      },
    ],
  };

  assert.equal(typeof buildFleetData, "function");

  const fleetData = buildFleetData(modelBreakdown);

  assert.equal(fleetData.length, 1);
  assert.equal(fleetData[0].label, "CLI");
  assert.equal(fleetData[0].usage, 1200);
  assert.equal(fleetData[0].totalPercent, "100.0");
});

test("buildFleetData returns model ids for stable keys", async () => {
  const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
  const buildFleetData = mod.buildFleetData;

  const modelBreakdown = {
    pricing: { pricing_mode: "list" },
    sources: [
      {
        source: "cli",
        totals: { total_tokens: 1200, total_cost_usd: 1.2 },
        models: [
          {
            model: "GPT-4o",
            model_id: "gpt-4o",
            totals: { total_tokens: 1200 },
          },
        ],
      },
    ],
  };

  const fleetData = buildFleetData(modelBreakdown);

  assert.equal(fleetData[0].models[0].id, "gpt-4o");
});

test("buildTopModels aggregates by model name across sources", async () => {
  const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
  const buildTopModels = mod.buildTopModels;

  const modelBreakdown = {
    sources: [
      {
        source: "cli",
        models: [{ model: "GPT-4o", totals: { billable_total_tokens: 70 } }],
      },
      {
        source: "api",
        models: [
          { model: "gpt-4o", totals: { billable_total_tokens: 50 } },
          { model: "GPT-4o-mini", totals: { billable_total_tokens: 30 } },
        ],
      },
    ],
  };

  assert.equal(typeof buildTopModels, "function");

  const topModels = buildTopModels(modelBreakdown, { limit: 3 });

  assert.equal(topModels.length, 2);
  assert.equal(topModels[0].id, "gpt-4o");
  assert.equal(topModels[0].name, "GPT-4o");
  assert.equal(topModels[0].percent, "80.0");
  assert.equal(topModels[1].id, "gpt-4o-mini");
  assert.equal(topModels[1].percent, "20.0");
});

test("buildTopModels computes percent using billable tokens across all models", async () => {
  const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
  const buildTopModels = mod.buildTopModels;

  const modelBreakdown = {
    sources: [
      {
        source: "cli",
        models: [
          { model: "legacy-model", totals: { billable_total_tokens: 20, total_tokens: 999 } },
        ],
      },
      {
        source: "api",
        models: [{ model: "GPT-4o", totals: { billable_total_tokens: 80, total_tokens: 999 } }],
      },
    ],
  };

  const topModels = buildTopModels(modelBreakdown, { limit: 1 });

  assert.equal(topModels.length, 1);
  assert.equal(topModels[0].id, "gpt-4o");
  assert.equal(topModels[0].percent, "80.0");
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-007: Kiro pricing in local-api MODEL_PRICING + byte-equivalence with
// dashboard/edge-patches/tokentracker-leaderboard-refresh.ts.
// ─────────────────────────────────────────────────────────────────────────────

test("getModelPricing returns non-zero rates for kiro-agent and kiro-cli-agent", () => {
  const kiroAgent = localApi.getModelPricing("kiro-agent");
  const kiroCliAgent = localApi.getModelPricing("kiro-cli-agent");
  assert.ok(kiroAgent.input > 0, "kiro-agent must price non-zero input");
  assert.ok(kiroAgent.output > 0, "kiro-agent must price non-zero output");
  assert.ok(kiroCliAgent.input > 0, "kiro-cli-agent must price non-zero input");
  assert.ok(kiroCliAgent.output > 0, "kiro-cli-agent must price non-zero output");
});

test("getModelPricing fuzzy-matches unknown kiro-* strings to non-zero", () => {
  const unknown = localApi.getModelPricing("kiro-future-model-xyz");
  assert.ok(unknown.input > 0, "fuzzy rule must catch kiro-* prefix");
  assert.ok(unknown.output > 0, "fuzzy rule must catch kiro-* prefix");
});

test("computeRowCost on kiro-cli-agent row is non-zero and matches claude-sonnet-4 rate", () => {
  const row = {
    model: "kiro-cli-agent",
    input_tokens: 1000,
    output_tokens: 500,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const cost = localApi.computeRowCost(row);
  assert.ok(cost > 0, "kiro-cli-agent row must have non-zero cost");

  const sonnetCost = localApi.computeRowCost({ ...row, model: "claude-sonnet-4-6" });
  assert.equal(
    cost,
    sonnetCost,
    "kiro-cli-agent rate MUST equal claude-sonnet-4-6 (documented decision: Kiro routes through Bedrock sonnet)",
  );
});

test("local-api MODEL_PRICING Kiro entries are byte-equivalent with leaderboard-refresh edge patch", () => {
  const edgeSrc = fs.readFileSync(leaderboardRefreshPath, "utf8");
  // Extract the literal Kiro pricing lines from the edge patch so byte-drift
  // between the two tables will fail this test.
  const localKiro = localApi.MODEL_PRICING["kiro-agent"];
  const localKiroCli = localApi.MODEL_PRICING["kiro-cli-agent"];
  assert.ok(localKiro && localKiroCli, "local-api must have both Kiro pricing entries");
  // Reconstruct the expected edge-patch line from local values.
  const expected = `"kiro-agent": { input: ${localKiro.input}, output: ${localKiro.output}, cache_read: ${localKiro.cache_read}, cache_write: ${localKiro.cache_write} },`;
  const expectedCli = `"kiro-cli-agent": { input: ${localKiroCli.input}, output: ${localKiroCli.output}, cache_read: ${localKiroCli.cache_read}, cache_write: ${localKiroCli.cache_write} },`;
  assert.ok(
    edgeSrc.includes(expected),
    `leaderboard-refresh must contain kiro-agent pricing matching local-api: ${expected}`,
  );
  assert.ok(
    edgeSrc.includes(expectedCli),
    `leaderboard-refresh must contain kiro-cli-agent pricing matching local-api: ${expectedCli}`,
  );
  // The fuzzy rule must also exist in the edge patch.
  assert.ok(
    edgeSrc.includes('lower.includes("kiro")'),
    "leaderboard-refresh must include the fuzzy kiro-* fallback rule",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-006: Consumer-boundary test against the REAL grouped shape
// (/functions/tokentracker-usage-model-breakdown) + buildFleetData. The
// buildTopModels assertions are flat-ranker sanity only — buildTopModels
// returns { id, name, tokens, percent } with NO source field.
// ─────────────────────────────────────────────────────────────────────────────

async function writeQueue(queuePath, rows) {
  await fs.promises.writeFile(queuePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function callModelBreakdown(queuePath, from, to) {
  const handler = localApi.createLocalApiHandler({ queuePath });
  const chunks = [];
  let statusCode = null;
  const urlString = `http://localhost/functions/tokentracker-usage-model-breakdown?from=${from}&to=${to}&tz=UTC`;
  const url = new URL(urlString);
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) {
      statusCode = code;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    write(chunk) {
      chunks.push(chunk);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, "model-breakdown endpoint must handle the request");
  const body = chunks.join("");
  return { statusCode: statusCode || res.statusCode, body: JSON.parse(body) };
}

test("merged Kiro source: IDE + CLI rows produce ONE sources[] entry with distinct model rows", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-merge-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const rows = [
      // IDE-origin row
      {
        source: "kiro",
        model: "kiro-agent",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 1000,
        output_tokens: 200,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 1200,
        conversation_count: 1,
      },
      // CLI-origin row (merged source, distinct model)
      {
        source: "kiro",
        model: "kiro-cli-agent",
        hour_start: "2026-04-20T10:30:00.000Z",
        input_tokens: 500,
        output_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 600,
        conversation_count: 1,
      },
    ];
    await writeQueue(queuePath, rows);

    const { body } = await callModelBreakdown(queuePath, "2026-04-20", "2026-04-20");

    // Server-side grouped shape
    assert.ok(Array.isArray(body.sources), "response must have sources[] array");
    const kiroSources = body.sources.filter((s) => s.source === "kiro");
    assert.equal(
      kiroSources.length,
      1,
      `exactly ONE kiro source entry expected; got ${kiroSources.length}`,
    );
    const kiro = kiroSources[0];
    assert.equal(kiro.totals.total_tokens, 1800, "total tokens must sum IDE + CLI rows");
    // total_cost_usd MUST be a STRING, not a Number (Swift decoder contract).
    assert.equal(typeof kiro.totals.total_cost_usd, "string");
    // Non-zero cost proves TASK-007 pricing is live (both models priced).
    assert.ok(
      parseFloat(kiro.totals.total_cost_usd) > 0,
      `kiro source total_cost_usd must be > 0 after TASK-007; got ${kiro.totals.total_cost_usd}`,
    );
    const models = kiro.models.map((m) => m.model).sort();
    assert.deepEqual(
      models,
      ["kiro-agent", "kiro-cli-agent"],
      "both IDE and CLI model rows must be preserved under the merged kiro source",
    );

    // Client-side grouped shape via buildFleetData
    const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
    const fleet = mod.buildFleetData(body);
    const kiroFleet = fleet.filter((f) => f.label === "KIRO");
    assert.equal(kiroFleet.length, 1, "buildFleetData must return exactly one KIRO entry");
    assert.equal(kiroFleet[0].usage, 1800);
    assert.equal(kiroFleet[0].models.length, 2);

    // Flat-ranker sanity — buildTopModels has NO source field; assert by name only.
    const top = mod.buildTopModels(body, { limit: 5 });
    const topNames = top.map((t) => t.name);
    assert.ok(topNames.some((n) => /kiro-agent/i.test(n)), "buildTopModels must expose kiro-agent");
    assert.ok(
      topNames.some((n) => /kiro-cli-agent/i.test(n)),
      "buildTopModels must expose kiro-cli-agent",
    );
    // Explicitly document buildTopModels's flat shape: no source attribution.
    for (const entry of top) {
      assert.equal(entry.source, undefined, "buildTopModels entries must NOT expose a .source field");
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("(source, model) collapse: IDE + CLI both resolving to claude-sonnet-4 merge into ONE row", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-collapse-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const rows = [
      {
        source: "kiro",
        model: "claude-sonnet-4-20250514",
        hour_start: "2026-04-20T10:00:00.000Z",
        input_tokens: 1000,
        output_tokens: 200,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 1200,
        conversation_count: 1,
      },
      {
        source: "kiro",
        model: "claude-sonnet-4-20250514",
        hour_start: "2026-04-20T10:30:00.000Z",
        input_tokens: 500,
        output_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 600,
        conversation_count: 1,
      },
    ];
    await writeQueue(queuePath, rows);

    const { body } = await callModelBreakdown(queuePath, "2026-04-20", "2026-04-20");
    const kiro = body.sources.find((s) => s.source === "kiro");
    assert.ok(kiro, "kiro source must exist");
    assert.equal(
      kiro.models.length,
      1,
      "identical (source, model) rows must collapse to ONE entry — intended merge behavior",
    );
    assert.equal(kiro.models[0].totals.total_tokens, 1800);

    // buildFleetData mirrors the server collapse
    const mod = await loadDashboardModule("dashboard/src/lib/model-breakdown.ts");
    const fleet = mod.buildFleetData(body);
    const kiroFleet = fleet.find((f) => f.label === "KIRO");
    assert.equal(kiroFleet.models.length, 1);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
