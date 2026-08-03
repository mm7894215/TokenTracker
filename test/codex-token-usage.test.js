"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MAX_USAGE_BASELINES,
  consumeUsageDelta,
  createUsageDeltaState,
  snapshotUsageBaselines,
} = require("../src/lib/codex-token-usage");

function usage(totalTokens) {
  return {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

test("usage delta state follows alternating cumulative lineages and skips repeated snapshots", () => {
  const state = createUsageDeltaState();
  const deltas = [
    consumeUsageDelta(state, usage(100), usage(100)),
    consumeUsageDelta(state, usage(200), usage(200)),
    consumeUsageDelta(state, usage(100), usage(100)),
    consumeUsageDelta(state, usage(50), usage(250)),
    consumeUsageDelta(state, usage(30), usage(130)),
  ];

  assert.deepEqual(deltas.map((delta) => delta?.total_tokens ?? null), [100, 200, null, 50, 30]);
  assert.equal(state.sawInterleaved, true);
  assert.equal(state.sawDivergentCumulative, true);
  assert.equal(snapshotUsageBaselines(state).length, 2);
});

test("usage delta state keeps one lineage across ordinary cumulative growth", () => {
  const state = createUsageDeltaState();
  assert.equal(consumeUsageDelta(state, usage(100), usage(100)).total_tokens, 100);
  assert.equal(consumeUsageDelta(state, usage(50), usage(150)).total_tokens, 50);
  assert.equal(consumeUsageDelta(state, usage(25), usage(175)).total_tokens, 25);
  assert.equal(state.sawInterleaved, false);
  assert.equal(state.sawDivergentCumulative, false);
  assert.equal(snapshotUsageBaselines(state).length, 1);
});

test("usage delta state retains the smaller cumulative delta when last usage is inconsistent", () => {
  const state = createUsageDeltaState();
  consumeUsageDelta(state, usage(15), usage(15));

  const delta = consumeUsageDelta(state, usage(150), usage(22));
  assert.equal(delta.total_tokens, 7);
  assert.equal(snapshotUsageBaselines(state).length, 1);
});

test("usage delta state bounds persisted stream heads", () => {
  const state = createUsageDeltaState();
  for (let index = 1; index <= MAX_USAGE_BASELINES + 5; index += 1) {
    const total = index * 1000;
    consumeUsageDelta(state, usage(total), usage(total));
  }

  assert.equal(snapshotUsageBaselines(state).length, MAX_USAGE_BASELINES);
});
