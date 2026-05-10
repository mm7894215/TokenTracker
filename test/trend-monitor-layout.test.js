const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("TrendMonitor root padding matches standard panel spacing", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../dashboard/src/ui/dashboard/components/TrendMonitor.jsx"),
    "utf8",
  );

  assert.ok(src.includes("export function TrendMonitor"), "expected TrendMonitor component");
  assert.ok(src.includes("p-5"), "expected standard panel padding");
  assert.ok(!src.includes("ASCII_CHARS"));
});
