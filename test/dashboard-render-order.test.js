const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("DashboardPage declares timeZone before use in range computation", () => {
  const filePath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");
  const src = fs.readFileSync(filePath, "utf8");
  const timeZoneDeclIndex = src.search(/\b(const|let)\s+timeZone\b/);
  const rangeUseIndex = src.indexOf("getRangeForPeriod(");

  assert.ok(timeZoneDeclIndex !== -1, "timeZone declaration not found");
  assert.ok(rangeUseIndex !== -1, "getRangeForPeriod usage not found");
  assert.ok(
    timeZoneDeclIndex < rangeUseIndex,
    "timeZone should be declared before getRangeForPeriod call",
  );
});

test("DashboardPage has no link code effect after install panel removal", () => {
  const filePath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");
  const src = fs.readFileSync(filePath, "utf8");
  assert.ok(!src.includes("linkCode"), "expected link code state/effect removed");
  assert.ok(!src.includes("init_link_code"), "expected link code install copy removed");
});
