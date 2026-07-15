const assert = require("node:assert/strict");
const test = require("node:test");

const {
  NATIVE_BACKGROUND_SYNC_INTERVAL_MS,
  startNativeBackgroundSync,
} = require("../src/commands/serve");

test("native serve schedules a lightweight all-source fallback sync", async () => {
  let intervalCallback = null;
  let intervalDelay = null;
  let clearedTimer = null;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const runSync = test.mock.fn(async () => {});
  const controller = startNativeBackgroundSync({
    appShell: "macos",
    runSync,
    setIntervalFn(callback, delay) {
      intervalCallback = callback;
      intervalDelay = delay;
      return timer;
    },
    clearIntervalFn(value) {
      clearedTimer = value;
    },
  });

  assert.ok(controller);
  assert.equal(intervalDelay, NATIVE_BACKGROUND_SYNC_INTERVAL_MS);
  assert.equal(timer.unrefCalled, true);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runSync.mock.callCount(), 1);
  assert.deepEqual(runSync.mock.calls[0].arguments[0], [
    "--auto",
    "--background",
    "--all-local-sources",
  ]);
  controller.stop();
  assert.equal(clearedTimer, timer);
});

test("native background sync coalesces overlapping ticks", async () => {
  let resolveSync;
  const errors = [];
  const runSync = test.mock.fn(() => new Promise((resolve) => { resolveSync = resolve; }));
  const controller = startNativeBackgroundSync({
    appShell: "windows",
    runSync,
    setIntervalFn() { return 1; },
    clearIntervalFn() {},
    onError(error) { errors.push(error); },
  });

  const first = controller.run();
  const second = controller.run();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runSync.mock.callCount(), 1);
  resolveSync();
  await first;
  assert.deepEqual(errors, []);
  controller.stop();
});

test("non-native serve does not start the fallback timer", () => {
  const setIntervalFn = test.mock.fn();
  const controller = startNativeBackgroundSync({ appShell: "", setIntervalFn });
  assert.equal(controller, null);
  assert.equal(setIntervalFn.mock.callCount(), 0);
});
