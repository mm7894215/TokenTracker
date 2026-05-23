/**
 * wrapped-aggregator unit tests.
 *
 * Verifies the pure aggregation logic across edge cases:
 *   - empty input → empty summary
 *   - year defaults to the latest year present in data
 *   - per-source / per-model totals and shares add to ≈1
 *   - peak hour-of-day picks the right bucket
 *   - longest consecutive day streak
 *   - --year filter excludes other years
 *   - billable_total_tokens preferred over total_tokens
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateWrapped, formatCompact } = require("../src/lib/wrapped-aggregator");

function row({ source, model, hour_start, total = 100, conv = 1, billable }) {
  return {
    source,
    model,
    hour_start,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: billable,
    conversation_count: conv,
  };
}

test("empty input returns a zeroed summary", () => {
  const w = aggregateWrapped([]);
  assert.equal(w.totals.tokens, 0);
  assert.equal(w.totals.active_days, 0);
  assert.deepEqual(w.top.sources, []);
});

test("year defaults to the most recent year present", () => {
  const w = aggregateWrapped([
    row({ source: "a", model: "m1", hour_start: "2024-01-05T00:00:00.000Z", total: 1 }),
    row({ source: "a", model: "m1", hour_start: "2026-03-10T00:00:00.000Z", total: 50 }),
  ]);
  assert.equal(w.year, 2026);
  // Only the 2026 row contributes
  assert.equal(w.totals.tokens, 50);
});

test("--year filter scopes the aggregate", () => {
  const w = aggregateWrapped(
    [
      row({ source: "a", model: "m1", hour_start: "2024-01-05T00:00:00.000Z", total: 7 }),
      row({ source: "b", model: "m2", hour_start: "2026-03-10T00:00:00.000Z", total: 70 }),
    ],
    { year: 2024 },
  );
  assert.equal(w.year, 2024);
  assert.equal(w.totals.tokens, 7);
  assert.equal(w.top.sources[0].source, "a");
});

test("source shares sum to ~1.0 and respect ranking", () => {
  const w = aggregateWrapped([
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 700 }),
    row({ source: "codex", model: "m2", hour_start: "2026-04-01T11:00:00.000Z", total: 200 }),
    row({ source: "cursor", model: "m3", hour_start: "2026-04-01T12:00:00.000Z", total: 100 }),
  ]);
  assert.equal(w.totals.tokens, 1000);
  assert.equal(w.top.sources[0].source, "claude");
  assert.equal(w.top.sources[0].share, 0.7);
  const sumShares = w.top.sources.reduce((s, x) => s + x.share, 0);
  assert.ok(Math.abs(sumShares - 1) < 1e-6);
});

test("peak hour-of-day picks the busiest UTC hour", () => {
  const w = aggregateWrapped([
    row({ source: "a", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 100 }),
    row({ source: "a", model: "m1", hour_start: "2026-04-02T14:00:00.000Z", total: 500 }),
    row({ source: "a", model: "m1", hour_start: "2026-04-03T14:30:00.000Z", total: 600 }),
  ]);
  assert.equal(w.peak_hour.hour, 14);
  assert.equal(w.peak_hour.tokens, 1100);
});

test("longest streak counts consecutive UTC days only", () => {
  // 3 in a row, 1-day gap, 1 by itself
  const w = aggregateWrapped([
    row({ source: "a", model: "m1", hour_start: "2026-02-21T00:00:00.000Z", total: 1 }),
    row({ source: "a", model: "m1", hour_start: "2026-02-22T00:00:00.000Z", total: 1 }),
    row({ source: "a", model: "m1", hour_start: "2026-02-23T00:00:00.000Z", total: 1 }),
    row({ source: "a", model: "m1", hour_start: "2026-02-25T00:00:00.000Z", total: 1 }),
  ]);
  assert.equal(w.longest_streak.days, 3);
  assert.equal(w.longest_streak.from, "2026-02-21");
  assert.equal(w.longest_streak.to, "2026-02-23");
});

test("billable_total_tokens beats total_tokens when both present", () => {
  const w = aggregateWrapped([
    row({
      source: "a",
      model: "m1",
      hour_start: "2026-04-01T10:00:00.000Z",
      total: 9999,
      billable: 42,
    }),
  ]);
  assert.equal(w.totals.tokens, 42);
});

test("highlights are populated for non-empty summaries", () => {
  const w = aggregateWrapped([
    row({ source: "claude", model: "claude-opus-4-7", hour_start: "2026-04-01T11:00:00.000Z", total: 1000 }),
    row({ source: "codex", model: "gpt-5", hour_start: "2026-04-01T12:00:00.000Z", total: 200 }),
    row({ source: "cursor", model: "auto", hour_start: "2026-04-02T11:00:00.000Z", total: 100 }),
    row({ source: "gemini", model: "gemini-2.0", hour_start: "2026-04-02T12:00:00.000Z", total: 50 }),
  ]);
  assert.ok(w.highlights.length >= 3);
  // Must mention the top model
  assert.ok(w.highlights.some((h) => h.includes("claude-opus-4-7")));
});

test("formatCompact magnitudes", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1500), "1.5K");
  assert.equal(formatCompact(2_500_000_000), "2.5B");
  assert.equal(formatCompact(1.234e12), "1.23T");
});
