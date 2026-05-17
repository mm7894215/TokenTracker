const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOpencodeTokens,
  sameGeminiTotals,
  diffGeminiTotals,
} = require("../src/lib/rollout.js");

// Per CLAUDE.md: cached_input_tokens = cache reads,
// cache_creation_input_tokens = cache writes. Any normalizer or diff that
// drops the cache_creation_input_tokens field silently under-reports cache
// writes — the bug we just fixed for OpenCode / OpenClaw / Gemini.

test("normalizeOpencodeTokens keeps cache.write separate from cache.read", () => {
  const n = normalizeOpencodeTokens({
    input: 100,
    output: 30,
    reasoning: 0,
    cache: { read: 50, write: 20 },
  });
  assert.equal(n.input_tokens, 100);
  assert.equal(n.cached_input_tokens, 50);
  assert.equal(n.cache_creation_input_tokens, 20);
  assert.equal(n.output_tokens, 30);
  assert.equal(n.total_tokens, 100 + 30 + 50 + 20);
});

test("sameGeminiTotals detects cache_creation_input_tokens changes", () => {
  const base = {
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_creation_input_tokens: 10,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 190,
  };
  const onlyCacheWriteGrew = { ...base, cache_creation_input_tokens: 25, total_tokens: 205 };
  // Before the fix, sameGeminiTotals ignored cache_creation_input_tokens and
  // returned true here — making diffGeminiTotals return null and dropping
  // the cache-write delta entirely.
  assert.equal(sameGeminiTotals(base, onlyCacheWriteGrew), false);
});

test("diffGeminiTotals preserves cache_creation_input_tokens delta", () => {
  const prev = {
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_creation_input_tokens: 10,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 190,
  };
  const curr = {
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_creation_input_tokens: 25,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 205,
  };
  const delta = diffGeminiTotals(curr, prev);
  assert.ok(delta, "delta should not be null when cache_creation grows");
  assert.equal(delta.cache_creation_input_tokens, 15);
  assert.equal(delta.total_tokens, 15);
});
