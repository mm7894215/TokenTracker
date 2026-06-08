const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

test("CLI no-args path starts serve with sync enabled", async () => {
  const cliPath = require.resolve("../src/cli");
  const servePath = require.resolve("../src/commands/serve");
  const originalLoad = Module._load;
  const calls = [];

  delete require.cache[cliPath];
  delete require.cache[servePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === servePath) {
      return {
        cmdServe: async (argv) => {
          calls.push(argv);
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const { run } = require("../src/cli");
    await run([]);
    assert.deepEqual(calls, [["--sync"]]);
  } finally {
    Module._load = originalLoad;
    delete require.cache[cliPath];
    delete require.cache[servePath];
  }
});
