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
  "claude-opus-4-6": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
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
  "gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
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

test("matcher: GPT-5.6 codex tiers resolve to their real curated rates (not the gpt-5 fallback)", () => {
  const curated = require("../src/lib/pricing/curated-overrides.json");
  // LiteLLM has no gpt-5.6 yet; simulate that so curated must win.
  const litellm = { "gpt-5": { input: 1.25, output: 10, cache_read: 0.125 } };
  const cases = [
    ["gpt-5.6-sol", 5, 30, "curated:exact"],
    ["gpt-5.6-terra", 2.5, 15, "curated:exact"],
    ["gpt-5.6-luna", 1, 6, "curated:exact"],
    // reasoning-effort variants codex appends must still land on the right tier
    ["gpt-5.6-sol-high", 5, 30, null],
    ["gpt-5.6-solhigh", 5, 30, "curated:fuzzy"],
    ["gpt-5.6-terrahigh", 2.5, 15, "curated:fuzzy"],
    // bare / unknown-tier falls back to the balanced terra tier, never gpt-5
    ["gpt-5.6", 2.5, 15, "curated:fuzzy"],
  ];
  for (const [model, input, output, source] of cases) {
    const r = matcher.lookupPricing(model, { curated, litellm, source: "codex" });
    assert.equal(r.hit, true, `${model} should resolve`);
    assert.equal(r.value.input, input, `${model} input`);
    assert.equal(r.value.output, output, `${model} output`);
    if (source) assert.equal(r.source, source, `${model} source`);
  }
});

test("matcher: lookupPricing fuzzy match restores `digit-digit` to `digit.digit` (droid GLM parity)", () => {
  // Droid dash-normalizes upstream `GLM-5.1` to `glm-5-1`, but curated keys
  // are dot-delimited. The matcher must retry a dot-restored variant of the
  // input so dash-form inputs still resolve to the dot-form curated entry.
  const curated = {
    exact: { "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 } },
    alias: {},
    fuzzy: [{ match: "glm-5.1", ref: "glm-5.1" }],
  };
  const r = matcher.lookupPricing("glm-5-1-0", { curated, litellm: {} });
  assert.equal(r.hit, true, "expected dot-form fuzzy fallback to hit");
  assert.equal(r.source, "curated:exact-dot");
  assert.equal(r.value.input, 1.4);
});

test("matcher: lookupPricing strips a LiteLLM provider prefix for bare queue models", () => {
  // Queue rows store bare model names; LiteLLM keys are provider-qualified.
  const curated = { exact: {}, alias: {}, fuzzy: [] };
  const litellm = { "openrouter/xiaomi/mimo-v2.5-pro": { input: 1, output: 3, cache_read: 0.2 } };
  const r = matcher.lookupPricing("mimo-v2.5-pro", { curated, litellm });
  assert.equal(r.hit, true);
  assert.equal(r.source, "litellm:prefix-strip");
  assert.equal(r.value.input, 1);
});

test("matcher: prefix-strip is deterministic across providers (smallest key wins, order-independent)", () => {
  const curated = { exact: {}, alias: {}, fuzzy: [] };
  // Two providers expose the same model at different cache rates. JSON
  // insertion order must NOT decide the winner — the lexicographically
  // smallest key ("novita/..." < "openrouter/...") always wins.
  const a = { input: 0.1, output: 0.3, cache_read: 0.01 };
  const b = { input: 0.1, output: 0.3, cache_read: 0.02 };
  const r1 = matcher.lookupPricing("mimo-v2-flash", {
    curated,
    litellm: { "openrouter/xiaomi/mimo-v2-flash": a, "novita/xiaomimimo/mimo-v2-flash": b },
  });
  const r2 = matcher.lookupPricing("mimo-v2-flash", {
    curated,
    litellm: { "novita/xiaomimimo/mimo-v2-flash": b, "openrouter/xiaomi/mimo-v2-flash": a },
  });
  assert.equal(r1.source, "litellm:prefix-strip");
  assert.equal(r1.value.cache_read, 0.02, "novita key (smallest) wins");
  assert.equal(r2.value.cache_read, 0.02, "winner independent of insertion order");
});

test("matcher: CURATED alias beats a LiteLLM provider-prefixed bare collision (auto → composer-1)", () => {
  // Regression: a `*/auto` LiteLLM entry must NOT hijack Cursor's "auto".
  // Alias (step 3) runs before prefix-strip (step 5b), so "auto" stays composer-1.
  const curated = {
    exact: { "composer-1": { input: 1.25, output: 10 } },
    alias: { auto: "composer-1" },
    fuzzy: [],
  };
  const litellm = { "openrouter/openrouter/auto": { input: 0, output: 0 } };
  const r = matcher.lookupPricing("auto", { curated, litellm });
  assert.equal(r.source, "curated:alias");
  assert.equal(r.value.input, 1.25);
});

test("matcher: LiteLLM exact beats prefix-strip when a canonical bare key exists", () => {
  const curated = { exact: {}, alias: {}, fuzzy: [] };
  const litellm = {
    "gpt-4": { input: 30, output: 60 },
    "azure/gpt-4": { input: 10, output: 30 },
  };
  const r = matcher.lookupPricing("gpt-4", { curated, litellm });
  assert.equal(r.source, "litellm:exact");
  assert.equal(r.value.input, 30, "canonical bare key wins over a provider-prefixed one");
});

test("matcher: lookupPricing dot-form fallback covers exact-only Droid model ids", () => {
  const curated = {
    exact: { "MiniMax-M2.1": { input: 0.5, output: 3, cache_read: 0.05 } },
    alias: {},
    fuzzy: [],
  };
  const r = matcher.lookupPricing("minimax-m2-1-0", { curated, litellm: {} });
  assert.equal(r.hit, true, "expected dot-form exact fallback to hit");
  assert.equal(r.source, "curated:exact-dot");
  assert.equal(r.value.output, 3);
});

test("matcher: lookupPricing dot-form fallback covers LiteLLM exact ids", () => {
  const r = matcher.lookupPricing("vendor-model-2-1", {
    curated: { exact: {}, alias: {}, fuzzy: [] },
    litellm: { "vendor-model-2.1": { input: 0.2, output: 0.8 } },
  });
  assert.equal(r.hit, true);
  assert.equal(r.source, "litellm:exact-dot");
  assert.equal(r.value.input, 0.2);
});

test("matcher: lookupPricing dot-form fallback does NOT corrupt models without digit-digit pairs", () => {
  // Regression: ensure `claude-3-7-sonnet` doesn't accidentally land on a
  // hypothetical `claude-3.7-sonnet` fuzzy entry if one ever exists. The
  // regex is digit-dash-digit only; the original lookup must run first.
  const curated = {
    exact: { "claude-3-7-sonnet": { input: 3, output: 15 } },
    alias: {},
    fuzzy: [],
  };
  const r = matcher.lookupPricing("claude-3-7-sonnet", {
    curated,
    litellm: {},
  });
  assert.equal(r.hit, true);
  assert.equal(r.source, "curated:exact");
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

test("matcher: Antigravity model aliases only apply to Antigravity source", () => {
  const litellm = { "gpt-4o": { input: 999, output: 999 } };
  const curated = {
    exact: { "antigravity-gpt-oss-120b": { input: 2.5, output: 10 } },
    alias: {},
    fuzzy: [],
  };
  const generic = matcher.lookupPricing("gpt-oss-120b", {
    curated,
    litellm,
    source: "openrouter",
  });
  assert.equal(generic.hit, false);

  const antigravity = matcher.lookupPricing("gpt-oss-120b", {
    curated,
    litellm,
    source: "antigravity",
  });
  assert.equal(antigravity.hit, true);
  assert.equal(antigravity.source, "curated:exact");
  assert.equal(antigravity.value.input, 2.5);
});

test("matcher: Antigravity model normalization covers families without gpt-4o fallback", () => {
  assert.equal(matcher.normalizeAntigravityModel("Gemini 3.5 Pro"), "gemini-2.5-pro");
  assert.equal(matcher.normalizeAntigravityModel("Gemini 3.5 Flash"), "gemini-2.5-flash");
  assert.equal(matcher.normalizeAntigravityModel("Claude Haiku 4.6"), "claude-haiku-4-6");
  assert.equal(
    matcher.normalizeAntigravityModel("gpt-oss-120b"),
    "antigravity-gpt-oss-120b",
  );
  assert.notEqual(matcher.normalizeAntigravityModel("gpt-oss-20b"), "gpt-4o");
});

test("matcher: Zed model normalization maps display names + ids to pricing keys", () => {
  // Display names with "(Preview)" / spaces.
  assert.equal(matcher.normalizeZedModel("Claude Sonnet 4"), "claude-sonnet-4");
  assert.equal(matcher.normalizeZedModel("GPT-5 (Preview)"), "gpt-5");
  assert.equal(matcher.normalizeZedModel("Gemini 3 Pro (Preview)"), "gemini-3-pro");
  // "fast" must NOT be stripped (it is part of grok-code-fast-1).
  assert.equal(matcher.normalizeZedModel("Grok Code Fast 1 (Preview)"), "grok-code-fast-1");
  // Claude minors hyphenate; GPT minors keep the dot.
  assert.equal(matcher.normalizeZedModel("Claude Opus 4.5"), "claude-opus-4-5");
  assert.equal(matcher.normalizeZedModel("claude-opus-4.8"), "claude-opus-4-8");
  assert.equal(matcher.normalizeZedModel("GPT-5.2"), "gpt-5.2");
  assert.equal(matcher.normalizeZedModel("gpt-5.5"), "gpt-5.5");
  // Slash-style ids pass through.
  assert.equal(matcher.normalizeZedModel("openai/gpt-oss-20b"), "openai/gpt-oss-20b");
});

test("matcher: Claude normalization maps dotted display names to curated keys", () => {
  assert.equal(matcher.normalizeClaudeModel("Claude Opus 4.8"), "claude-opus-4-8");
  assert.equal(matcher.normalizeClaudeModel("claude-opus-4.8"), "claude-opus-4-8");
  assert.equal(matcher.normalizeClaudeModel("claude-opus-4.8-20260601"), "claude-opus-4-8-20260601");
  assert.equal(matcher.normalizeClaudeModel("opus-4-6"), "claude-opus-4-6");
  assert.equal(matcher.normalizeClaudeModel("opus-4.6"), "claude-opus-4-6");
  assert.equal(matcher.normalizeClaudeModel("opus8[1m]"), "opus8-1m");
  assert.equal(matcher.normalizeClaudeModel("4.6"), "4.6");
});

test("matcher: Claude normalization handles relay/gateway ids (#212)", () => {
  // Provider path prefix is stripped; standard OpenRouter order is preserved.
  assert.equal(matcher.normalizeClaudeModel("anthropic/claude-opus-4.6"), "claude-opus-4-6");
  assert.equal(
    matcher.normalizeClaudeModel("openrouter/anthropic/claude-opus-4.6"),
    "claude-opus-4-6",
  );
  // Inverted tier/version order from relays (the #212 model name), with date.
  assert.equal(
    matcher.normalizeClaudeModel("anthropic/claude-4.6-opus-20260205"),
    "claude-opus-4-6-20260205",
  );
  assert.equal(matcher.normalizeClaudeModel("claude-4-6-opus"), "claude-opus-4-6");
  assert.equal(matcher.normalizeClaudeModel("anthropic/claude-4.6-sonnet"), "claude-sonnet-4-6");
  // Claude 3.x is genuinely version-first and must NOT be reordered.
  assert.equal(
    matcher.normalizeClaudeModel("claude-3-5-sonnet-20241022"),
    "claude-3-5-sonnet-20241022",
  );
  assert.equal(matcher.normalizeClaudeModel("claude-3-7-sonnet"), "claude-3-7-sonnet");
  assert.equal(matcher.normalizeClaudeModel("claude-3-opus-20240229"), "claude-3-opus-20240229");
});

test("matcher: Zed normalization only applies to the zed source", () => {
  const litellm = { "claude-opus-4-8": { input: 5, output: 25 } };
  const curated = { exact: {}, alias: {}, fuzzy: [] };
  // Under source=zed the display/dotted name resolves via normalization.
  const zed = matcher.lookupPricing("Claude Opus 4.8 (Preview)", { curated, litellm, source: "zed" });
  assert.equal(zed.hit, true);
  assert.equal(zed.value.input, 5);
  // Other sources do not get the Zed normalization (dotted name won't match).
  const other = matcher.lookupPricing("Claude Opus 4.8 (Preview)", { curated, litellm, source: "openrouter" });
  assert.equal(other.hit, false);
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

test("index: getModelPricing resolves claude-fable-5 from CURATED (not yet in LiteLLM)", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  // Fable 5 is Anthropic's top tier ($10/$50) and absent from LiteLLM, so the
  // curated exact entry must win or the dashboard renders $0 cost.
  const fable = pricing.getModelPricing("claude-fable-5");
  assert.equal(fable.input, 10);
  assert.equal(fable.output, 50);
  assert.equal(fable.cache_read, 1);
  assert.equal(fable.cache_write, 12.5);
  // End-to-end: a row must produce non-zero cost.
  const cost = pricing.computeRowCost({
    source: "claude",
    model: "claude-fable-5",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  });
  assert.equal(cost, 10);
});

test("index: getModelPricing resolves GLM-5.2 from CURATED for ZCode rows", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  // ZCode (Z.ai) reports its own GLM usage as model "GLM-5.2" (uppercase,
  // dotted). It's absent from LiteLLM, so the curated exact key must win or the
  // dashboard renders $0 cost. Z.ai list rates: $1.4 / $4.4 / $0.26 per 1M.
  const glm = pricing.getModelPricing("GLM-5.2", { source: "zcode" });
  assert.equal(glm.input, 1.4);
  assert.equal(glm.output, 4.4);
  assert.equal(glm.cache_read, 0.26);
  // End-to-end: a ZCode row must produce non-zero cost.
  const cost = pricing.computeRowCost({
    source: "zcode",
    model: "GLM-5.2",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  });
  assert.equal(cost, 1.4);
});

test("index: getModelPricing resolves Sakana Fugu Ultra from CURATED (issue #214)", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  // Fugu is an OpenAI-compatible API used through Codex/Cursor/Cline/ZCode etc.;
  // its model id reaches the queue in several shapes. All must resolve to the
  // curated $5/$30 rate or the dashboard renders $0 cost (it's absent from
  // LiteLLM). OpenRouter list rates: $5 / $30 / $0.5 per 1M in/out/cache_read.
  const exact = pricing.getModelPricing("sakana/fugu-ultra");
  assert.equal(exact.input, 5);
  assert.equal(exact.output, 30);
  assert.equal(exact.cache_read, 0.5);
  // Bare name, official dated id, and provider-prefixed form all hit the "fugu"
  // curated fuzzy match.
  for (const id of ["fugu-ultra", "fugu-ultra-20260615", "openrouter/sakana/fugu-ultra"]) {
    const p = pricing.getModelPricing(id);
    assert.equal(p.input, 5, `${id} input`);
    assert.equal(p.output, 30, `${id} output`);
  }
  // End-to-end: a Fugu row carried by ZCode (issue #216) bills non-zero.
  const cost = pricing.computeRowCost({
    source: "zcode",
    model: "fugu-ultra",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  });
  assert.equal(cost, 35); // 5 (input) + 30 (output)
});

test("index: getModelPricing resolves Claude Opus 4.8 aliases from CURATED", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });

  const dotted = pricing.getModelPricing("claude-opus-4.8", { source: "claude" });
  assert.equal(dotted.input, 5);
  assert.equal(dotted.output, 25);
  assert.equal(dotted.cache_read, 0.5);
  assert.equal(dotted.cache_write, 6.25);

  const typo = pricing.getModelPricing("opus8[1m]", { source: "claude" });
  assert.equal(typo.input, 0);
  assert.equal(typo.output, 0);

  const dated = pricing.getModelPricing("claude-opus-4.8-20260601", { source: "claude" });
  assert.equal(dated.input, 5);
  assert.equal(dated.output, 25);

  const familyOnlyDash = pricing.getModelPricing("opus-4-6", { source: "claude" });
  assert.equal(familyOnlyDash.input, 5);
  assert.equal(familyOnlyDash.output, 25);

  const familyOnlyDot = pricing.getModelPricing("opus-4.6", { source: "claude" });
  assert.equal(familyOnlyDot.input, 5);
  assert.equal(familyOnlyDot.output, 25);

  const bareVersion = pricing.getModelPricing("4.6", { source: "claude" });
  assert.equal(bareVersion.input, 0);
  assert.equal(bareVersion.output, 0);

  // Regression for GitHub #178: the reporter's latest-version row previously
  // rendered zero because the model id used a dotted minor (`4.8`).
  const issueRowCost = pricing.computeRowCost({
    source: "claude",
    model: "claude-opus-4.8",
    hour_start: "2026-06-12T00:30:00.000Z",
    input_tokens: 846_877,
    cached_input_tokens: 2_750_316,
    cache_creation_input_tokens: 568_789,
    output_tokens: 13_169,
    reasoning_output_tokens: 0,
    total_tokens: 4_179_151,
    billable_total_tokens: 4_179_151,
    conversation_count: 2,
  });
  assert.equal(issueRowCost, 9.49369925);
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

test("index: computeRowCost scopes Antigravity-only model aliases by source", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  const row = {
    model: "gpt-oss-120b",
    input_tokens: 1_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 1_000,
    reasoning_output_tokens: 0,
  };
  assert.equal(pricing.computeRowCost({ ...row, source: "openrouter" }), 0);
  assert.equal(pricing.computeRowCost({ ...row, source: "antigravity" }), 0.0125);
  assert.equal(pricing.computeRowCost({ ...row, model: "gpt-oss-20b", source: "antigravity" }), 0);
});

test("index: negative cache is scoped by source for Antigravity aliases", async () => {
  pricing.resetPricingForTests();
  const cachePath = tmpCachePath();
  await pricing.ensurePricingLoaded({
    cachePath,
    fetchImpl: makeFetchImpl(FIXTURE_LITELLM),
  });
  assert.equal(pricing.getModelPricing("gpt-oss-120b", { source: "openrouter" }).input, 0);
  assert.equal(
    pricing.getModelPricing("gpt-oss-120b", { source: "antigravity" }).input,
    2.5,
  );
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

test("index: Pi GitHub Copilot rows keep token usage but have zero estimated API cost", () => {
  pricing.resetPricingForTests();
  const row = {
    source: "pi-github-copilot",
    model: "claude-sonnet-4-6",
    input_tokens: 100_000,
    output_tokens: 20_000,
    cached_input_tokens: 10_000,
    cache_creation_input_tokens: 5_000,
    reasoning_output_tokens: 0,
  };
  assert.equal(pricing.computeRowCost(row), 0);
  assert.ok(pricing.computeRowCost({ ...row, source: "pi-anthropic" }) > 0);
  assert.ok(pricing.getModelPricing("Claude Opus 4.8", { source: "pi-anthropic" }).output > 0);
});

test("index: getModelPricing returns ZERO for empty/null model", () => {
  pricing.resetPricingForTests();
  assert.equal(pricing.getModelPricing("").input, 0);
  assert.equal(pricing.getModelPricing(null).input, 0);
  assert.equal(pricing.getModelPricing(undefined).input, 0);
});

test("index: ensurePricingLoaded is idempotent (concurrent callers share one fetch)", async () => {
  pricing.resetPricingForTests();
  const revisionBeforeLoad = pricing.getPricingRevision();
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
  assert.equal(pricing.getPricingRevision(), revisionBeforeLoad + 1);
  await pricing.ensurePricingLoaded({ cachePath, fetchImpl });
  assert.equal(pricing.getPricingRevision(), revisionBeforeLoad + 1);
});

test("WorkBuddy: hy3-preview-agent has real Hunyuan token pricing (not $0)", () => {
  pricing.resetPricingForTests();
  const hy3 = pricing.getModelPricing("hy3-preview-agent", { source: "workbuddy" });
  // Tencent TokenHub: 1.2 / 0.4 / 4.0 RMB per MTok in/read/out at ~7.2 RMB/USD.
  assert.equal(hy3.input, 0.167);
  assert.equal(hy3.cache_read, 0.056);
  assert.equal(hy3.output, 0.556);
  assert.equal(hy3.cache_write, 0.167, "DeepSeek-style cache: write billed at input rate");
});

test("WorkBuddy: 'auto' router prices as hy3, NOT Cursor's composer-1 (Plan A)", () => {
  pricing.resetPricingForTests();
  const wbAuto = pricing.getModelPricing("auto", { source: "workbuddy" });
  const hy3 = pricing.getModelPricing("hy3-preview-agent", { source: "workbuddy" });
  assert.deepEqual(
    { i: wbAuto.input, o: wbAuto.output, r: wbAuto.cache_read },
    { i: hy3.input, o: hy3.output, r: hy3.cache_read },
    "WorkBuddy auto must inherit hy3 pricing",
  );
  // Cursor's "auto" must remain composer-1 — the remap is source-scoped.
  const cursorAuto = pricing.getModelPricing("auto", { source: "cursor" });
  assert.equal(cursorAuto.input, 1.25, "Cursor auto still resolves to composer-1");
});

test("WorkBuddy: computeRowCost bills auto + hy3 rows at the hy3 rate", () => {
  pricing.resetPricingForTests();
  const row = (model) => ({
    source: "workbuddy",
    model,
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  });
  assert.equal(pricing.computeRowCost(row("auto")), 0.167);
  assert.equal(pricing.computeRowCost(row("hy3-preview-agent")), 0.167);
});
