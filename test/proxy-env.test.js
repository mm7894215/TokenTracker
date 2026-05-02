const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseMacProxyOutput,
  resolveSystemProxyEnv,
  relaunchWithProxyEnvIfNeeded,
} = require("../src/lib/proxy-env");

test("parseMacProxyOutput extracts enabled HTTPS system proxy", () => {
  const output = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}
`;

  assert.equal(parseMacProxyOutput(output), "http://127.0.0.1:7897");
});

test("resolveSystemProxyEnv enables Node env proxy for explicit proxy env", () => {
  assert.deepEqual(
    resolveSystemProxyEnv({
      env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
      platform: "linux",
    }),
    { NODE_USE_ENV_PROXY: "1" },
  );
});

test("resolveSystemProxyEnv reads macOS system proxy when no proxy env exists", () => {
  const result = resolveSystemProxyEnv({
    env: {},
    platform: "darwin",
    commandRunner(command, args) {
      assert.equal(command, "scutil");
      assert.deepEqual(args, ["--proxy"]);
      return {
        status: 0,
        stdout: "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n",
      };
    },
  });

  assert.deepEqual(result, {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    HTTP_PROXY: "http://127.0.0.1:7897",
  });
});

test("relaunchWithProxyEnvIfNeeded only relaunches serve-like commands once", () => {
  const calls = [];
  const result = relaunchWithProxyEnvIfNeeded({
    argv: ["serve", "--no-open"],
    originalArgv: ["bin/tracker.js", "serve", "--no-open"],
    env: {},
    platform: "darwin",
    nodePath: "/usr/local/bin/node",
    commandRunner(command, args, options) {
      calls.push({ command, args, options });
      if (command === "scutil") {
        return {
          status: 0,
          stdout: "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n",
        };
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { status: 0 });
  assert.equal(calls[1].command, "/usr/local/bin/node");
  assert.deepEqual(calls[1].args, ["bin/tracker.js", "serve", "--no-open"]);
  assert.equal(calls[1].options.env.NODE_USE_ENV_PROXY, "1");
  assert.equal(calls[1].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(calls[1].options.env.TOKENTRACKER_PROXY_ENV_APPLIED, "1");

  const skipped = relaunchWithProxyEnvIfNeeded({
    argv: ["serve"],
    env: { TOKENTRACKER_PROXY_ENV_APPLIED: "1" },
    platform: "darwin",
    commandRunner() {
      throw new Error("should not run");
    },
  });
  assert.equal(skipped, null);
});
