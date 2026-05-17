const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const hookFiles = [
  "dashboard/src/hooks/use-usage-data.ts",
  "dashboard/src/hooks/use-usage-model-breakdown.ts",
  "dashboard/src/hooks/use-trend-data.ts",
  "dashboard/src/hooks/use-activity-heatmap.ts",
];

async function readHookSource(relativePath) {
  const absPath = path.join(repoRoot, relativePath);
  return fs.readFile(absPath, "utf8");
}

function assertMissingJwtGuard(source, file) {
  // Cloud (account-view) mode bypasses the local-JWT guard because it
  // authenticates separately via accountAccessToken; allow `&& !useCloud`
  // as an optional trailing clause in addition to the historical
  // `&& !isLocalMode` clause.
  const guardRegex = /if\s*\(\s*!resolvedToken\s*&&\s*!mockEnabled\s*(?:&&\s*!isLocalMode\s*)?(?:&&\s*!useCloud\s*)?\)\s*return\s*;/;
  assert.ok(
    guardRegex.test(source),
    `expected missing-JWT guard in ${file} ("if (!resolvedToken && !mockEnabled) return;")`,
  );
}

test("hooks stop requests when access token is missing (no guest bypass)", async () => {
  for (const file of hookFiles) {
    const source = await readHookSource(file);
    assertMissingJwtGuard(source, file);
  }
});
