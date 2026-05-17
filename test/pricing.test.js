// Pricing resolver — unit tests for the LiteLLM + curated-overrides hybrid.
//
// Network is mocked via a fetchImpl injection so these tests are deterministic
// and offline-safe.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const matcher = require("../src/lib/pricing/matcher");
const fetcher = require("../src/lib/pricing/litellm-fetcher");
const pricing = require("../src/lib/pricing");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pricing-"));
  return path.join(dir, "pricing.json");
}

function makeFetchImpl(payload, { delayMs = 0, fail = false } = {}) {
  return async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw new Error("simulated network failure");
    return payload;
  };
}

// Sample LiteLLM-shape data covering the cases tests will assert on.
const FIXTURE_LITELLM = {
  "claude-sonnet-4-6": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  "claude-haiku-4-5-20251001": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
  "gpt-5.4": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
  },
  "gpt-5-codex": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
  },
  "gemini-2.5-pro": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
  },
  // Make sure the seed includes an entry CURATED also defines, so we can
  // assert CURATED wins.
  "kiro-cli-agent": {
    input_cost_per_token: 999e-6,
    output_cost_per_token: 999e-6,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// matcher.js — pure logic, no I/O

test("matcher: lookupPricing returns CURATED.exact match before LiteLLM", () => {
  const curated = {
    exact: { foo: { input: 1, output: 2 } },
    alias: {},
    fuzzy: [],
  };
  const litellm = { foo: { input: 999, output: 999 } };
  const r = matcher.lookupPricing("foo", { curated, litellm });
  assert.equal(r.hit, true);
  assert.equal(r.source, "curated:exact");
  assert.equal(r.value.input, 1);
});

test("matcher: lookupPricing falls back to LiteLLM exact when CURATED has no entry", () => {
  const curated = { exact: {}, alias: {}, fuzzy: [] };
  const litellm = { "gpt-5.4": { input: 2.5, output: 15 } };
  const r = matcher.lookupPricing("gpt-5.4", { curated, litellm });
  assert.equal(r.hit, true);
  assert.equal(r.source, "litellm:exact");
});

test("matcher: lookupPricing handles CURATED alias (literal mapping)", () => {
  const curated = {
    exact: { "composer-1": { input: 1.25, output: 10 } },
    alias: { auto: "composer-1" },
    fuzzy: [],
  };
  const r = matcher.lookupPricing("auto", { curated, litellm: {} });
  assert.equal(r.hit, true);
  assert.equal(r.source, "curated:alias");
  assert.equal(r.value.input, 1.25);
});

test("matcher: lookupPricing handles CURATED fuzzy substring (kiro-future-xyz → kiro-cli-agent)", () => {
  const curated = {
    exact: { "kiro-cli-agent": { input: 3, output: 15 } },
    alias: {},
    fuzzy: [{ match: "kiro", ref: "kiro-cli-agent" }],
  };
  const r = matcher.lookupPricing("kiro-future-xyz", { curated, litellm: {} });
  assert.equal(r.hit, true);
  assert.equal(r.source, "curated:fuzzy");
});

test("matcher: lookupPricing strips reasoning effort suffix to find LiteLLM base model", () => {
  const litellm = { "gpt-5-codex": { input: 1.25, output: 10 } };
  const r = matcher.lookupPricing("gpt-5-codex-high-fast", {
    curated: { exact: {}, alias: {}, fuzzy: [] },
    litellm,
  });
  assert.equal(r.hit, true);
  assert.equal(r.source, "litellm:strip");
  assert.equal(r.value.input, 1.25);
});

test("matcher: lookupPricing reverse-substring picks longest matching key", () => {
  const litellm = {
    "gpt-5": { input: 1, output: 1 },
    "gpt-5-codex": { input: 2, output: 2 },
  };
  const r = matcher.lookupPricing("gpt-5-codex-experimental", {
    curated: { exact: {}, alias: {}, fuzzy: [] },
    litellm,
  });
  assert.equal(r.hit, true);
  // Longest match wins — gpt-5-codex over gpt-5.
  assert.equal(r.source, "litellm:fuzzy");
  assert.equal(r.value.input, 2);
});

test("matcher: lookupPricing returns miss for completely unknown model", () => {
  const r = matcher.lookupPricing("totally-unknown-xyz-2099", {
    curated: { exact: {}, alias: {}, fuzzy: [] },
    litellm: { "gpt-5": { input: 1 } },
  });
  assert.equal(r.hit, false);
});

test("matcher: convertLitellmEntry rounds away float drift (1e-7 * 1e6 must be 0.1)", () => {
  const out = matcher.convertLitellmEntry({
    input_cost_per_token: 1e-6,
    cache_read_input_token_cost: 1e-7,
  });
  assert.equal(out.input, 1);
  assert.equal(out.cache_read, 0.1, "0.09999... must round to 0.1");
});

test("matcher: buildLitellmPerMillionMap skips _meta and entries without cost fields", () => {
  const map = matcher.buildLitellmPerMillionMap({
    _meta: { source: "x", cached_at: "now" },
    "gpt-5": { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
    "info-only": { mode: "chat", max_tokens: 100 },
  });
  assert.deepEqual(Object.keys(map), ["gpt-5"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// litellm-fetcher.js — disk cache + seed fallback

test("fetcher: fresh disk cache is loaded without invoking fetch", async () => {
  const cachePath = tmpCachePath();
  await fsp.writeFile(
    cachePath,
    JSON.stringify({
      _meta: { source: "test", cached_at: new Date().toISOString() },
      "fake-model": { input_cost_per_token: 1e-6 },
    }),
  );
  let fetchCalls = 0;
  const result = await fetcher.loadLitellmData({
    cachePath,
    fetchImpl: async () => {
      fetchCalls++;
      return {};
    },
  });
  assert.equal(result.source, "disk-cache");
  assert.equal(fetchCalls, 0);
  assert.ok(result.data["fake-model"], "data round-trips through cache");
});

test("fetcher: stale disk cache triggers fetch, writes new cache", async () => {
  const cachePath = tmpCachePath();
  // Write a "stale" file (mtime 25h ago).
  await fsp.writeFile(cachePath, JSON.stringify({ _meta: {}, "old-model": {} }));
  const stale = Date.now() - 25 * 60 * 60 * 1000;
  await fsp.utimes(cachePath, new Date(stale), new Date(stale));

  const result = await fetcher.loadLitellmData({
    cachePath,
    fetchImpl: makeFetchImpl({
      "fresh-model": { input_cost_per_token: 2e-6 },
    }),
  });
  assert.equal(result.source, "upstream");
  assert.ok(result.data["fresh-model"]);
  // Cache file rewritten:
  const onDisk = JSON.parse(await fsp.readFile(cachePath, "utf8"));
  assert.ok(onDisk["fresh-model"]);
  assert.ok(!onDisk["old-model"], "stale entry replaced");
});

test("fetcher: fetch failure with no cache falls back to seed snapshot", async () => {
  const cachePath = tmpCachePath();
  // Don't pre-populate; ensure ENOENT path.
  const result = await fetcher.loadLitellmData({
    cachePath,
    fetchImpl: makeFetchImpl(null, { fail: true }),
  });
  assert.equal(result.source, "seed-snapshot");
  // Seed bundles ~2k models; spot-check a known one.
  assert.ok(result.data["gpt-5"], "seed must contain gpt-5");
});

test("fetcher: fetch failure with stale cache prefers stale cache over seed", async () => {
  const cachePath = tmpCachePath();
  await fsp.writeFile(
    cachePath,
    JSON.stringify({ _meta: {}, "stale-but-real": { input_cost_per_token: 5e-6 } }),
  );
  const stale = Date.now() - 25 * 60 * 60 * 1000;
  await fsp.utimes(cachePath, new Date(stale), new Date(stale));

  const result = await fetcher.loadLitellmData({
    cachePath,
    fetchImpl: makeFetchImpl(null, { fail: true }),
  });
  assert.equal(result.source, "stale-cache");
  assert.ok(result.data["stale-but-real"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// index.js — public API + negative cache + computeRowCost contract

test("index: ensurePricingLoaded + getModelPricing returns CURATED for kiro entries", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  const kiro = pricing.getModelPricing("kiro-cli-agent");
  // CURATED says 3 / 15; LiteLLM fixture intentionally has 999/999 to verify
  // CURATED wins the race.
  assert.equal(kiro.input, 3);
  assert.equal(kiro.output, 15);
  assert.equal(kiro.cache_read, 0.3);
  assert.equal(kiro.cache_write, 3.75);
});

test("index: getModelPricing finds LiteLLM mainstream models with correct unit conversion", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  const sonnet = pricing.getModelPricing("claude-sonnet-4-6");
  assert.equal(sonnet.input, 3);
  assert.equal(sonnet.output, 15);
  assert.equal(sonnet.cache_read, 0.3);
  assert.equal(sonnet.cache_write, 3.75);
});

test("index: getModelPricing populates negativeCache and short-circuits second call", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  const state = pricing.__getStateForTests();
  pricing.getModelPricing("nonexistent-model-xyz");
  assert.ok(state.negativeCache.has("nonexistent-model-xyz"));
  // Mutate map to ensure the second call uses the negative cache, not the
  // map.
  state.litellmPerMillionMap["nonexistent-model-xyz"] = { input: 999 };
  const second = pricing.getModelPricing("nonexistent-model-xyz");
  assert.equal(second.input, 0, "negative cache must short-circuit");
});

test("index: computeRowCost on Codex row does NOT double-count reasoning", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  // Mirrors the contract assertion in test/model-breakdown.test.js:179.
  const row = {
    source: "codex",
    model: "gpt-5.4",
    input_tokens: 50_000,
    cached_input_tokens: 950_000,
    cache_creation_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_output_tokens: 4_000,
  };
  const cost = pricing.computeRowCost(row);
  const expected = 0.125 + 0.2375 + 0.15;
  assert.ok(
    Math.abs(cost - expected) < 1e-9,
    `expected ${expected}, got ${cost}`,
  );
});

test("index: computeRowCost on non-Codex source DOES bill reasoning tokens", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  const base = {
    source: "gemini",
    model: "gemini-2.5-pro",
    input_tokens: 1_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 1_000,
    reasoning_output_tokens: 0,
  };
  const w = pricing.computeRowCost({ ...base, reasoning_output_tokens: 5_000 });
  const wo = pricing.computeRowCost(base);
  assert.ok(w > wo, "reasoning must be billed for non-Codex sources");
});

test("index: getModelPricing returns ZERO for empty/null model", () => {
  pricing.resetPricingForTests();
  assert.equal(pricing.getModelPricing("").input, 0);
  assert.equal(pricing.getModelPricing(null).input, 0);
  assert.equal(pricing.getModelPricing(undefined).input, 0);
});

test("index: ensurePricingLoaded is idempotent (concurrent callers share one fetch)", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return FIXTURE_LITELLM;
  };
  const [a, b, c] = await Promise.all([
    pricing.ensurePricingLoaded({ cachePath, fetchImpl }),
    pricing.ensurePricingLoaded({ cachePath, fetchImpl }),
    pricing.ensurePricingLoaded({ cachePath, fetchImpl }),
  ]);
  assert.equal(fetchCalls, 1, "concurrent callers must share one fetch");
  assert.equal(a.loaded, true);
  assert.equal(b.loaded, true);
  assert.equal(c.loaded, true);
});
