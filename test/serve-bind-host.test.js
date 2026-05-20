const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { LOCAL_BIND_HOST, getLocalServerUrl } = require("../src/commands/serve");

test("serve binds to loopback and advertises the loopback URL", () => {
  assert.equal(LOCAL_BIND_HOST, "127.0.0.1");
  assert.equal(getLocalServerUrl(7680), "http://127.0.0.1:7680");
});

test("serve startup does not persistently rewrite config.json", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "commands", "serve.js"), "utf8");
  assert.doesNotMatch(source, /writeJson\s*\(\s*cfgPath/);
  assert.doesNotMatch(source, /cfg\.baseUrl\s*=/);
});
