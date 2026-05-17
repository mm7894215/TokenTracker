// Native-consumer contract lock (TASK-008).
//
// This test mirrors the Swift decoder contract in
// TokenTrackerBar/TokenTrackerBar/Models/ModelBreakdown.swift and
// TokenTrackerBar/TokenTrackerBar/Models/TokenTotals.swift. It exists because
// the Swift `decodeIfPresent` logic for CodingKeys cannot recover from type
// regressions — specifically a change of `total_cost_usd` from String to
// Number would crash the decoder in production with dataCorruptedError on
// every macOS client. A full XCTest lane would require xcodebuild wiring and
// is out of scope here; this Node test pins the JSON shape the Swift app
// depends on so future edits to src/lib/local-api.js cannot silently break
// the native consumer.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const localApi = require("../src/lib/local-api");

async function callModelBreakdown(queuePath) {
  const handler = localApi.createLocalApiHandler({ queuePath });
  const urlString =
    "http://localhost/functions/tokentracker-usage-model-breakdown?from=2026-04-20&to=2026-04-20&tz=UTC";
  const url = new URL(urlString);
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    end(body) {
      if (body) chunks.push(body);
    },
    write(chunk) {
      chunks.push(chunk);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, "handler must accept the request");
  return JSON.parse(chunks.join(""));
}

function isInt(v) {
  return typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v;
}

test("model-breakdown JSON exposes every field the Swift ModelBreakdown decoder reads", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-native-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const fixtureSrc = fs.readFileSync(
      path.join(__dirname, "fixtures", "kiro-cli", "native-contract-queue.jsonl"),
      "utf8",
    );
    await fs.promises.writeFile(queuePath, fixtureSrc);

    const body = await callModelBreakdown(queuePath);

    // ModelBreakdownResponse CodingKeys: from, to, days, sources, pricing
    assert.equal(typeof body.from, "string", "`from` must be a string");
    assert.equal(typeof body.to, "string", "`to` must be a string");
    assert.equal(typeof body.days, "number", "`days` must be a number");
    assert.ok(Array.isArray(body.sources), "`sources` must be an array");
    assert.ok(body.pricing && typeof body.pricing === "object", "`pricing` must be an object");

    // PricingInfo.pricing_mode: String
    assert.equal(
      typeof body.pricing.pricing_mode,
      "string",
      "pricing.pricing_mode must be a string (Swift CodingKey: pricing_mode → pricingMode)",
    );

    const kiro = body.sources.find((s) => s.source === "kiro");
    assert.ok(kiro, "fixture must produce a kiro source");

    // SourceEntry CodingKeys: source (String), totals (TokenTotals), models ([ModelEntry])
    assert.equal(typeof kiro.source, "string");
    assert.ok(kiro.totals && typeof kiro.totals === "object");
    assert.ok(Array.isArray(kiro.models));

    // TokenTotals CodingKeys — every field Swift decodes with .decodeIfPresent(Int.self ...)
    // must be present as Int, and total_cost_usd MUST be String.
    const tt = kiro.totals;
    const intFields = [
      "total_tokens",
      "billable_total_tokens",
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "cache_creation_input_tokens",
      "reasoning_output_tokens",
    ];
    for (const f of intFields) {
      assert.ok(isInt(tt[f]), `totals.${f} must be an integer number (Swift Int), got ${typeof tt[f]}`);
    }

    // CRITICAL: total_cost_usd must be a STRING. If this regresses to Number
    // the Swift decoder will crash in production with dataCorruptedError —
    // this is the exact failure mode this test exists to prevent.
    assert.equal(
      typeof tt.total_cost_usd,
      "string",
      "sources[].totals.total_cost_usd MUST be a String — Swift decodes it as String",
    );
    assert.match(
      tt.total_cost_usd,
      /^\d+\.\d{6}$/,
      "total_cost_usd must be 6-decimal formatted (e.g. '0.001234')",
    );

    // ModelEntry CodingKeys: model (String), model_id (String), totals (TokenTotals)
    assert.ok(kiro.models.length > 0, "kiro must have at least one model row");
    for (const m of kiro.models) {
      assert.equal(typeof m.model, "string");
      assert.equal(typeof m.model_id, "string");
      assert.ok(m.totals && typeof m.totals === "object");
      assert.equal(
        typeof m.totals.total_cost_usd,
        "string",
        `models[${m.model}].totals.total_cost_usd MUST be a String`,
      );
      for (const f of intFields) {
        assert.ok(
          isInt(m.totals[f]),
          `models[${m.model}].totals.${f} must be an integer`,
        );
      }
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("non-zero cost on merged kiro source proves TASK-007 pricing is live end-to-end", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-kirocli-native-cost-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const fixtureSrc = fs.readFileSync(
      path.join(__dirname, "fixtures", "kiro-cli", "native-contract-queue.jsonl"),
      "utf8",
    );
    await fs.promises.writeFile(queuePath, fixtureSrc);

    const body = await callModelBreakdown(queuePath);
    const kiro = body.sources.find((s) => s.source === "kiro");
    assert.ok(kiro);
    const sourceCost = parseFloat(kiro.totals.total_cost_usd);
    assert.ok(
      sourceCost > 0,
      `kiro source total_cost_usd must be > 0 with TASK-007 pricing live; got ${kiro.totals.total_cost_usd}`,
    );
    // Each model row must also have non-zero cost — proves BOTH kiro-agent
    // and kiro-cli-agent are resolved by the pricing table.
    for (const m of kiro.models) {
      const modelCost = parseFloat(m.totals.total_cost_usd);
      assert.ok(
        modelCost > 0,
        `kiro model '${m.model}' must have non-zero cost; got ${m.totals.total_cost_usd}`,
      );
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
