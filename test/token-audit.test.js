const assert = require("node:assert/strict");
const { test } = require("node:test");

const { auditRows } = require("../scripts/audit-token-correctness.cjs");

test("auditRows reports source totals, duplicate buckets, and invariant failures", () => {
  const result = auditRows([
    {
      source: "gemini",
      model: "gemini-2.5-pro",
      hour_start: "2026-04-20T10:00:00.000Z",
      input_tokens: 10,
      cached_input_tokens: 20,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 15,
      conversation_count: 1,
    },
    {
      source: "gemini",
      model: "gemini-2.5-pro",
      hour_start: "2026-04-20T10:00:00.000Z",
      input_tokens: 10,
      cached_input_tokens: 20,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 35,
      conversation_count: 1,
    },
    {
      source: "cursor",
      model: "auto",
      hour_start: "2026-04-20T10:00:00.000Z",
      input_tokens: 1,
      cached_input_tokens: 99,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 100,
      conversation_count: 1,
    },
  ]);

  assert.equal(result.sources.gemini.rows, 1, "latest row per bucket should be used for totals");
  assert.equal(result.sources.gemini.duplicate_bucket_keys, 1);
  assert.equal(result.sources.gemini.invariant_failures, 0);
  assert.equal(result.sources.cursor.source_scope, "account");
  assert.equal(result.sources.cursor.cache_read_ratio, 0.99);
  assert.equal(result.raw.duplicate_bucket_keys, 1);
});

test("auditRows treats Codex reasoning as informational for total-token invariants", () => {
  const result = auditRows([
    {
      source: "codex",
      model: "gpt-5.4",
      hour_start: "2026-04-01T10:00:00.000Z",
      input_tokens: 50,
      cached_input_tokens: 950,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 4,
      total_tokens: 1010,
      conversation_count: 1,
    },
  ]);

  assert.equal(result.sources.codex.sum_parts, 1010);
  assert.equal(result.sources.codex.invariant_failures, 0);
  assert.deepEqual(result.invariant_samples, []);
});

test("auditRows normalizes legacy Codex input that already includes cache reads", () => {
  const result = auditRows([
    {
      source: "codex",
      model: "gpt-5.4",
      hour_start: "2026-04-01T10:00:00.000Z",
      input_tokens: 1000,
      cached_input_tokens: 950,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 4,
      total_tokens: 1010,
      conversation_count: 1,
    },
  ]);

  assert.equal(result.sources.codex.input_tokens, 50);
  assert.equal(result.sources.codex.sum_parts, 1010);
  assert.equal(result.sources.codex.invariant_failures, 0);
});

test("auditRows accepts Codex totals where reasoning is not folded into output", () => {
  const result = auditRows([
    {
      source: "codex",
      model: "gpt-5.4",
      hour_start: "2026-04-01T10:00:00.000Z",
      input_tokens: 50,
      cached_input_tokens: 950,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 4,
      total_tokens: 1014,
      conversation_count: 1,
    },
  ]);

  assert.equal(result.sources.codex.sum_parts, 1014);
  assert.equal(result.sources.codex.invariant_failures, 0);
});
