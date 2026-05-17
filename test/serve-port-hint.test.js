const assert = require("node:assert/strict");
const { test } = require("node:test");

const { buildPortInUseHint, NPM_PACKAGE_NAME } = require("../src/commands/serve");

test("serve port collision hint references the published npm package name", () => {
  assert.equal(NPM_PACKAGE_NAME, "tokentracker-cli");
  assert.equal(
    buildPortInUseHint(7681),
    "Port 7681 is still in use after cleanup. Try: npx tokentracker-cli serve --port 7682\n",
  );
});
