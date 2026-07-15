const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const pagePath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");

test("local dashboard reload scans all local sources before refreshing usage snapshots", () => {
  const source = fs.readFileSync(pagePath, "utf8");
  assert.match(
    source,
    /triggerLocalSync\(\{\s*auto:\s*true,\s*background:\s*true,\s*allLocalSources:\s*true,?\s*\}\)/,
    "DMG page reloads should request the all-local background sync path",
  );
  assert.match(
    source,
    /localReloadSyncPromiseRef\.current[\s\S]*\.then\(\(\) => \{[\s\S]*refreshUsageStats\(\)/,
    "usage endpoints should be re-read after the reload-triggered sync finishes",
  );
});
