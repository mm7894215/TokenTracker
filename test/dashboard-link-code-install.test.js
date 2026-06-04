const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const copyPath = path.join(__dirname, "..", "dashboard", "src", "content", "copy.csv");
const pagePath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("copy registry keeps only sync install command needed by daily empty state", () => {
  const csv = readFile(copyPath);
  assert.ok(csv.includes("dashboard.install.cmd.sync"), "missing sync command copy key");
});

test("DashboardPage does not wire link code install copy flow", () => {
  const src = readFile(pagePath);
  assert.ok(!src.includes("dashboard.install.cmd.init"), "expected base install command removed");
  assert.ok(!src.includes("dashboard.install.cmd.init_link_code"), "expected link code install command removed");
  assert.ok(!src.includes("installInitCmdDisplay"), "expected install display removed");
  assert.ok(!src.includes("safeWriteClipboard,"), "expected text clipboard helper import removed");
});
