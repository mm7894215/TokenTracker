const assert = require("node:assert/strict");
const { test } = require("node:test");

const { LOCAL_BIND_HOST, getLocalServerUrl } = require("../src/commands/serve");

test("serve binds to loopback and advertises the loopback URL", () => {
  assert.equal(LOCAL_BIND_HOST, "127.0.0.1");
  assert.equal(getLocalServerUrl(7680), "http://127.0.0.1:7680");
});
