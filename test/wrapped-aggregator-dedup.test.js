/**
 * Regression test: queue.jsonl is append-only — each sync re-emits the
 * cumulative totals for every touched bucket. aggregateWrapped must
 * dedupe by (source, model, hour_start) before summing, otherwise
 * `tracker wrapped` over-counts by the number of sync runs.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateWrapped } = require("../src/lib/wrapped-aggregator");

function row({ source, model, hour_start, total }) {
  return {
    source,
    model,
    hour_start,
    total_tokens: total,
    conversation_count: 1,
  };
}

test("aggregateWrapped dedupes by (source, model, hour_start) keeping latest", () => {
  // Three appends of the same bucket — represents three sync runs where
  // each emitted the cumulative total to date (100 → 250 → 300).
  const w = aggregateWrapped([
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 100 }),
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 250 }),
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 300 }),
  ]);
  assert.equal(w.totals.tokens, 300, "must keep latest cumulative, not sum all three");
});

test("different buckets are not deduped against each other", () => {
  const w = aggregateWrapped([
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 100 }),
    row({ source: "claude", model: "m1", hour_start: "2026-04-01T11:00:00.000Z", total: 200 }),
    row({ source: "codex", model: "m1", hour_start: "2026-04-01T10:00:00.000Z", total: 50 }),
  ]);
  assert.equal(w.totals.tokens, 350);
});
