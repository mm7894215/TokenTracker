const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseMacProxyOutput,
  pickProxyUrl,
  resolveSystemProxyEnv,
  relaunchWithProxyEnvIfNeeded,
  applyUndiciProxyIfNeeded,
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

test("pickProxyUrl honors uppercase, lowercase, and ALL_PROXY env vars", () => {
  assert.equal(pickProxyUrl({}), null);
  assert.equal(pickProxyUrl({ HTTPS_PROXY: "http://h:1" }), "http://h:1");
  assert.equal(pickProxyUrl({ https_proxy: "http://l:2" }), "http://l:2");
  assert.equal(pickProxyUrl({ HTTP_PROXY: "http://h:3" }), "http://h:3");
  assert.equal(pickProxyUrl({ ALL_PROXY: "socks5://a:4" }), "socks5://a:4");
  // HTTPS_PROXY beats HTTP_PROXY when both are set
  assert.equal(
    pickProxyUrl({ HTTPS_PROXY: "http://h:1", HTTP_PROXY: "http://h:9" }),
    "http://h:1",
  );
});

test("applyUndiciProxyIfNeeded sets a ProxyAgent dispatcher when proxy env exists", () => {
  let captured = null;
  const FakeAgent = function (url) {
    this.url = url;
    captured = this;
  };
  const setter = (dispatcher) => {
    captured = dispatcher;
  };

  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
    setGlobalDispatcher: setter,
    ProxyAgent: FakeAgent,
  });

  assert.equal(result, "http://127.0.0.1:7897");
  assert.ok(captured instanceof FakeAgent);
  assert.equal(captured.url, "http://127.0.0.1:7897");
});

test("applyUndiciProxyIfNeeded is a no-op when no proxy env var is set", () => {
  let called = false;
  const result = applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: () => {
      called = true;
    },
    ProxyAgent: function () {},
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("applyUndiciProxyIfNeeded swallows ProxyAgent construction errors", () => {
  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "not-a-url" },
    setGlobalDispatcher: () => {},
    ProxyAgent: function () {
      throw new Error("bad url");
    },
  });
  assert.equal(result, null);
});

test("applyUndiciProxyIfNeeded actually swaps the real undici dispatcher", () => {
  const undici = require("undici");
  const previous = undici.getGlobalDispatcher();
  try {
    const result = applyUndiciProxyIfNeeded({
      env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
    });
    assert.equal(result, "http://127.0.0.1:7897");
    const dispatcher = undici.getGlobalDispatcher();
    assert.notEqual(dispatcher, previous);
    assert.ok(dispatcher instanceof undici.ProxyAgent);
  } finally {
    undici.setGlobalDispatcher(previous);
  }
});
