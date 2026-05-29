"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUsageSummary,
  renderUsageSummary,
} = require("../src/lib/usage-summary");
const { parseArgs } = require("../src/commands/usage");

test("usage summary exports local totals, daily data, and top breakdowns", () => {
  const rows = [
    {
      source: "claude",
      model: "claude-sonnet-4-5",
      hour_start: "2026-05-01T10:00:00.000Z",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      billable_total_tokens: 150,
      conversation_count: 1,
    },
    {
      source: "codex",
      model: "gpt-5",
      hour_start: "2026-05-02T10:00:00.000Z",
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      billable_total_tokens: 300,
      conversation_count: 2,
    },
  ];

  const summary = buildUsageSummary(rows, { from: "2026-05-01", to: "2026-05-01" });

  assert.equal(summary.local_only, true);
  assert.deepEqual(summary.range, { from: "2026-05-01", to: "2026-05-01" });
  assert.equal(summary.rows, 1);
  assert.equal(summary.days, 1);
  assert.equal(summary.totals.total_tokens, 150);
  assert.equal(summary.totals.billable_total_tokens, 150);
  assert.equal(summary.totals.conversation_count, 1);
  assert.equal(typeof summary.totals.total_cost_usd, "string");
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.top_sources[0].name, "claude");
  assert.equal(summary.top_models[0].name, "claude-sonnet-4-5");
});

test("usage summary text includes cost and local scope", () => {
  const summary = buildUsageSummary([
    {
      source: "codex",
      model: "gpt-5",
      hour_start: "2026-05-01T10:00:00.000Z",
      total_tokens: 1000,
      billable_total_tokens: 1000,
    },
  ]);

  const text = renderUsageSummary(summary);
  assert.match(text, /TokenTracker usage \(local\)/);
  assert.match(text, /Estimated cost: \$/);
  assert.match(text, /Top tools:/);
});

test("usage args accept explicit local-only scripts and reject invalid dates", () => {
  assert.deepEqual(parseArgs(["--json", "--local-only", "--from", "2026-05-01"]), {
    from: "2026-05-01",
    to: null,
    json: true,
    localOnly: true,
  });

  assert.throws(() => parseArgs(["--from", "2026/05/01"]), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(["--from", "2026-05-02", "--to", "2026-05-01"]), /--from/);
});
