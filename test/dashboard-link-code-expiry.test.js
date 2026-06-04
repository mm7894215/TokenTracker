const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pagePath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("DashboardPage does not schedule link code expiry after install panel removal", () => {
  const src = readFile(pagePath);
  assert.ok(!src.includes("linkCodeExpiryTick"), "expected link code expiry tick state removed");
  assert.ok(!src.includes("setLinkCodeExpiryTick"), "expected link code expiry tick updater removed");
  assert.ok(!src.includes("linkCodeRefreshToken"), "expected link code refresh trigger state removed");
  assert.ok(!src.includes("setLinkCodeRefreshToken"), "expected link code refresh trigger updater removed");
});
