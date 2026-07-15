const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const servePath = path.join(__dirname, "..", "src", "commands", "serve.js");

test("DMG server startup repairs all supported runtime integrations", () => {
  const source = fs.readFileSync(servePath, "utf8");
  assert.match(source, /repairRuntimeIntegrations/);
  assert.doesNotMatch(source, /repairCodexNotifyIntegration/);
});
