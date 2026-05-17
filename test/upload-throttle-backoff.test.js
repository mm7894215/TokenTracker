const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeState,
  recordUploadFailure,
  recordUploadSuccess,
  decideAutoUpload,
  parseRetryAfterMs,
} = require("../src/lib/upload-throttle");

// The sync loop ignored HTTP errors entirely: the `catch` block only printed
// a message and never touched upload.throttle.json, so 429 / 5xx spam would
// not back off. These tests pin down the behavior we now depend on: after
// drainQueueToCloud throws, recordUploadFailure advances nextAllowedAtMs so
// the next decideAutoUpload call is throttled.

test("recordUploadFailure without Retry-After uses exponential backoff and blocks next decide", () => {
  const now = 1_000_000;
  const fresh = normalizeState({});
  const afterFail = recordUploadFailure({
    nowMs: now,
    state: fresh,
    error: { status: 500, message: "HTTP 500: internal error" },
  });
  assert.ok(afterFail.backoffUntilMs > now, "backoffUntilMs should advance past now");
  assert.ok(afterFail.nextAllowedAtMs >= afterFail.backoffUntilMs);
  assert.equal(afterFail.backoffStep, 1);
  assert.equal(afterFail.lastError, "HTTP 500: internal error");

  const decision = decideAutoUpload({
    nowMs: now + 1000,
    pendingBytes: 50_000,
    state: afterFail,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "throttled");
});

test("Retry-After header honored when present", () => {
  const now = 1_000_000;
  const retryAfterMs = parseRetryAfterMs("120"); // 120 seconds
  assert.equal(retryAfterMs, 120_000);

  const state = recordUploadFailure({
    nowMs: now,
    state: normalizeState({}),
    error: { status: 429, message: "rate limited", retryAfterMs },
  });
  // Backoff honors Retry-After (clamped to [initial, max]).
  assert.ok(state.backoffUntilMs >= now + 60_000);
});

test("recordUploadSuccess resets backoffStep so transient failure doesn't stick", () => {
  const now = 1_000_000;
  let state = normalizeState({});
  state = recordUploadFailure({
    nowMs: now,
    state,
    error: { status: 500, message: "fail" },
  });
  assert.equal(state.backoffStep, 1);
  state = recordUploadSuccess({ nowMs: now + 5_000, state });
  assert.equal(state.backoffStep, 0);
  assert.equal(state.backoffUntilMs, 0);
  assert.equal(state.lastError, null);
});

test("repeated failures escalate backoffStep", () => {
  const now = 1_000_000;
  let state = normalizeState({});
  for (let i = 0; i < 3; i++) {
    state = recordUploadFailure({
      nowMs: now + i,
      state,
      error: { status: 500, message: "fail" },
    });
  }
  assert.equal(state.backoffStep, 3);
  // The third failure's backoff window should be longer than the first's.
  const firstRun = recordUploadFailure({
    nowMs: now,
    state: normalizeState({}),
    error: { status: 500, message: "fail" },
  });
  assert.ok(state.backoffUntilMs - (now + 2) > firstRun.backoffUntilMs - now);
});
