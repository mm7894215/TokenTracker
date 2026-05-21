const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stripDebugFlag } = require("../src/lib/debug-flags");

test("stripDebugFlag detects --debug and env flags", () => {
  const res = stripDebugFlag(["--debug", "init"], { TOKENTRACKER_DEBUG: "0" });
  assert.deepEqual(res.argv, ["init"]);
  assert.equal(res.debug, true);

  const envDebug = stripDebugFlag(["status"], { TOKENTRACKER_DEBUG: "1" });
  assert.deepEqual(envDebug.argv, ["status"]);
  assert.equal(envDebug.debug, true);

  const legacyEnv = stripDebugFlag(["status"], { UNKNOWN_DEBUG_FLAG: "1" });
  assert.equal(legacyEnv.debug, false);
});
