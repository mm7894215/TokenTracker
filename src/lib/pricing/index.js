// Public pricing API. Replaces the hard-coded MODEL_PRICING table that used
// to live in src/lib/local-api.js. Keeps the same synchronous shape so all
// existing callers (computeRowCost, /functions/* handlers, tests) work
// unchanged after `await ensurePricingLoaded()` is awaited once at startup.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const curatedOverrides = require("./curated-overrides.json");
const {
  lookupPricing,
  buildLitellmPerMillionMap,
} = require("./matcher");
const { loadLitellmData } = require("./litellm-fetcher");

const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const PI_SUBSCRIPTION_SOURCES = new Set(["pi-github-copilot", "pi-copilot"]);
const SEED_SNAPSHOT_PATH = path.resolve(__dirname, "seed-snapshot.json");

// Sync seed load. Done at require-time so callers that haven't awaited
// ensurePricingLoaded() (e.g. tests, vite mock startup, edge functions) still
// get LiteLLM-backed pricing instead of all-zero. ensurePricingLoaded() will
// later upgrade this to fresh disk cache or upstream data.
function loadSeedSync() {
  try {
    const raw = fs.readFileSync(SEED_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    delete parsed._meta;
    return parsed;
  } catch (e) {
    return {};
  }
}

const seedRaw = loadSeedSync();

const state = {
  loaded: false,
  loadingPromise: null,
  revision: 0,
  litellmRawMap: seedRaw, // raw per-token; field shape from LiteLLM JSON
  litellmPerMillionMap: buildLitellmPerMillionMap(seedRaw), // USD/MTok
  source: Object.keys(seedRaw).length ? "seed-snapshot:sync" : null,
  // negativeCache prevents re-walking the LiteLLM map for models we've already
  // determined are unknown. Cleared on every reload.
  negativeCache: new Set(),
};

function defaultCachePath() {
  return path.join(os.homedir(), ".tokentracker", "cache", "pricing.json");
}

async function ensurePricingLoaded(opts = {}) {
  if (state.loaded) return state;
  if (state.loadingPromise) return state.loadingPromise;

  state.loadingPromise = (async () => {
    try {
      const cachePath = opts.cachePath || defaultCachePath();
      const { data, source } = await loadLitellmData({ ...opts, cachePath });
      state.litellmRawMap = data || {};
      state.litellmPerMillionMap = buildLitellmPerMillionMap(state.litellmRawMap);
      state.source = source;
      state.loaded = true;
      state.revision += 1;
      state.negativeCache.clear();
      return state;
    } finally {
      state.loadingPromise = null;
    }
  })();

  return state.loadingPromise;
}

// For tests: drop loaded state so a fresh call can re-load. Seeds with the
// bundled snapshot so getModelPricing() still works without ensurePricingLoaded.
function resetPricingForTests() {
  state.loaded = false;
  state.loadingPromise = null;
  state.litellmRawMap = seedRaw;
  state.litellmPerMillionMap = buildLitellmPerMillionMap(seedRaw);
  state.source = Object.keys(seedRaw).length ? "seed-snapshot:sync" : null;
  state.revision += 1;
  state.negativeCache.clear();
}

function getPricingRevision() {
  return state.revision;
}

function getModelPricing(model, opts = {}) {
  if (!model) return ZERO_PRICING;
  let lookupSource = null;
  if (typeof opts === "string") {
    lookupSource = opts.toLowerCase();
  } else if (typeof opts.source === "string") {
    lookupSource = opts.source.toLowerCase();
  }
  const cacheKey = lookupSource ? `${lookupSource}\0${model}` : model;
  if (state.negativeCache.has(cacheKey)) return ZERO_PRICING;

  const result = lookupPricing(model, {
    curated: curatedOverrides,
    litellm: state.litellmPerMillionMap,
    source: lookupSource,
  });
  if (result.hit) return result.value;

  state.negativeCache.add(cacheKey);
  return ZERO_PRICING;
}

// Same formula and Codex/every-code reasoning-folding rule as the previous
// computeRowCost in src/lib/local-api.js. Moved here so vite mock + local
// server share one source of truth.
function computeRowCost(row) {
  // Pi can route a turn through a subscription-backed Copilot provider. Pi's
  // usage record reports a zero marginal cost for those turns; do not
  // reinterpret the Claude model name as an Anthropic API bill.
  if (PI_SUBSCRIPTION_SOURCES.has(String(row?.source || "").toLowerCase())) return 0;
  const pricing = getModelPricing(row.model, { source: row.source });
  const reasoningIncludedInOutput = row.source === "codex" || row.source === "every-code";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (pricing.output || 0);
  return (
    ((row.input_tokens || 0) * (pricing.input || 0) +
      (row.output_tokens || 0) * (pricing.output || 0) +
      (row.cached_input_tokens || 0) * (pricing.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (pricing.cache_write || 0) +
      reasoningCost) /
    1_000_000
  );
}

// Backwards-compatible MODEL_PRICING export. Test at
// test/model-breakdown.test.js:236 reads `localApi.MODEL_PRICING["kiro-agent"]`
// and expects { input, output, cache_read, cache_write } shape. We expose the
// CURATED.exact map (which contains the kiro entries by design); LiteLLM
// entries are NOT included here because they're keyed dynamically and the old
// table was authoritative for what is now CURATED.
const MODEL_PRICING = curatedOverrides.exact;

module.exports = {
  ensurePricingLoaded,
  getPricingRevision,
  getModelPricing,
  computeRowCost,
  resetPricingForTests,
  MODEL_PRICING,
  ZERO_PRICING,
  // Internal hooks for tests.
  __getStateForTests: () => state,
};
