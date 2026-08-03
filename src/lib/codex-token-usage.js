"use strict";

// A rollout can contain TokenCount events from more than one Codex SessionState
// (for example, a parent agent and an embedded reviewer). Each SessionState has
// its own cumulative total, but the event does not carry a stable stream id.
// Recover the stream from Codex's invariant: total - last = that stream's prior
// total. Keeping a small LRU of stream heads also makes repeated rate-limit
// snapshots idempotent when the streams are interleaved.

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const MAX_USAGE_BASELINES = 32;

function canonicalUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  let sawNumber = false;
  for (const field of USAGE_FIELDS) {
    const raw = field === "cache_creation_input_tokens"
      ? value.cache_creation_input_tokens ?? value.cache_write_input_tokens
      : value[field];
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) {
      out[field] = Math.floor(number);
      sawNumber = true;
    } else {
      out[field] = 0;
    }
  }
  return sawNumber ? out : null;
}

function usageSignature(value) {
  const usage = canonicalUsage(value);
  return usage ? USAGE_FIELDS.map((field) => usage[field]).join(":") : null;
}

function sameUsage(left, right) {
  const leftSignature = usageSignature(left);
  return leftSignature !== null && leftSignature === usageSignature(right);
}

function subtractUsage(totalUsage, lastUsage) {
  const total = canonicalUsage(totalUsage);
  const last = canonicalUsage(lastUsage);
  if (!total || !last) return null;
  const previous = {};
  for (const field of USAGE_FIELDS) {
    if (total[field] < last[field]) return null;
    previous[field] = total[field] - last[field];
  }
  return previous;
}

function diffUsage(totalUsage, previousUsage) {
  const total = canonicalUsage(totalUsage);
  const previous = canonicalUsage(previousUsage);
  if (!total || !previous) return null;
  const delta = {};
  for (const field of USAGE_FIELDS) {
    delta[field] = Math.max(0, total[field] - previous[field]);
  }
  return delta;
}

function totalsReset(totalUsage, previousUsage) {
  const total = canonicalUsage(totalUsage);
  const previous = canonicalUsage(previousUsage);
  return Boolean(total && previous && total.total_tokens < previous.total_tokens);
}

function createUsageDeltaState({ lastTotal = null, baselines = null } = {}) {
  const state = {
    lastTotal: null,
    baselines: [],
    sawDivergentCumulative: false,
    sawInterleaved: false,
  };
  for (const baseline of Array.isArray(baselines) ? baselines : []) {
    touchBaseline(state, baseline);
  }
  if (canonicalUsage(lastTotal)) touchBaseline(state, lastTotal);
  return state;
}

function snapshotUsageBaselines(state) {
  return Array.isArray(state?.baselines)
    ? state.baselines.map((usage) => ({ ...usage }))
    : [];
}

function consumeUsageDelta(state, lastUsage, totalUsage) {
  if (!state || typeof state !== "object") {
    throw new TypeError("usage delta state is required");
  }
  if (!Array.isArray(state.baselines)) state.baselines = [];

  const last = canonicalUsage(lastUsage);
  const total = canonicalUsage(totalUsage);
  if (!total) return last;

  const activeSignature = usageSignature(state.lastTotal);
  const duplicateIndex = findBaselineIndex(state, total);
  if (duplicateIndex >= 0) {
    if (
      activeSignature !== null &&
      usageSignature(state.baselines[duplicateIndex]) !== activeSignature
    ) {
      state.sawInterleaved = true;
    }
    touchBaselineAt(state, duplicateIndex, total);
    return null;
  }

  if (last) {
    const expectedPrevious = subtractUsage(total, last);
    const lineageIndex = findBaselineIndex(state, expectedPrevious);
    if (lineageIndex >= 0) {
      if (
        activeSignature !== null &&
        usageSignature(state.baselines[lineageIndex]) !== activeSignature
      ) {
        state.sawInterleaved = true;
      }
      touchBaselineAt(state, lineageIndex, total);
      return last;
    }
    if (expectedPrevious) {
      if (canonicalUsage(state.lastTotal)) state.sawDivergentCumulative = true;
      touchBaseline(state, total);
      return last;
    }
  }

  const active = canonicalUsage(state.lastTotal);
  if (active && !totalsReset(total, active)) {
    const delta = diffUsage(total, active);
    if (!last || Number(delta?.total_tokens || 0) <= Number(last.total_tokens || 0)) {
      const activeIndex = findBaselineIndex(state, active);
      touchBaselineAt(state, activeIndex, total);
      return delta;
    }

    // A cumulative jump larger than last usage cannot come from the normal
    // append_last_usage path. Treat it as a new stream instead of charging the
    // unrelated cumulative gap; a later event will establish its lineage.
    state.sawDivergentCumulative = true;
  }

  touchBaseline(state, total);
  return last || total;
}

function findBaselineIndex(state, usage) {
  const signature = usageSignature(usage);
  if (signature === null) return -1;
  return state.baselines.findIndex((baseline) => usageSignature(baseline) === signature);
}

function touchBaselineAt(state, index, usage) {
  const canonical = canonicalUsage(usage);
  if (!canonical) return;
  if (Number.isInteger(index) && index >= 0 && index < state.baselines.length) {
    state.baselines.splice(index, 1);
  } else {
    const duplicateIndex = findBaselineIndex(state, canonical);
    if (duplicateIndex >= 0) state.baselines.splice(duplicateIndex, 1);
  }
  state.baselines.push(canonical);
  while (state.baselines.length > MAX_USAGE_BASELINES) state.baselines.shift();
  state.lastTotal = canonical;
}

function touchBaseline(state, usage) {
  touchBaselineAt(state, findBaselineIndex(state, usage), usage);
}

module.exports = {
  MAX_USAGE_BASELINES,
  canonicalUsage,
  consumeUsageDelta,
  createUsageDeltaState,
  diffUsage,
  sameUsage,
  snapshotUsageBaselines,
  subtractUsage,
  totalsReset,
  usageSignature,
};
