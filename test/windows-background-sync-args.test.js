const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Windows background sync passes bounded args while manual sync stays full", () => {
  const serverManager = read("TokenTrackerWin/ServerManager.cs");
  const trayContext = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(
    trayContext,
    /new\(\)\s*\{\s*Interval\s*=\s*5\s*\*\s*60\s*\*\s*1000\s*\}/,
    "Windows tray background sync timer should remain a 5-minute timer",
  );
  assert.match(
    trayContext,
    /_syncTimer\.Tick \+= \(_, _\) => TriggerBackgroundSync\(\)/,
    "Windows timer tick should route through TriggerBackgroundSync",
  );
  assert.match(
    trayContext,
    /ServerStatus\.Running[\s\S]*_syncTimer\.Start\(\);[\s\S]*TriggerBackgroundSync\(\);/,
    "Windows server-running path should trigger the same background sync path",
  );
  assert.match(
    serverManager,
    /public void TriggerBackgroundSync\(\)[\s\S]*StartSync\(auto: true\);/,
    "Windows background sync should select the auto path",
  );
  assert.match(
    serverManager,
    /auto\s*\?\s*new\[\]\s*\{\s*"sync",\s*"--auto",\s*"--background"\s*\}\s*:\s*new\[\]\s*\{\s*"sync"\s*\}/,
    "Windows background args should use sync --auto --background while manual sync remains plain sync",
  );
  assert.doesNotMatch(
    serverManager,
    /new\[\]\s*\{\s*"sync",\s*"--auto"\s*\}/,
    "Windows background sync must not retain the bare sync --auto pattern",
  );
});
