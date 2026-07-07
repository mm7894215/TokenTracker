const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("Windows high-frequency background sync uses explicit background args", () => {
  const serverManager = read("TokenTrackerWin/ServerManager.cs");
  const trayContext = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(trayContext, /new\(\)\s*\{\s*Interval\s*=\s*5\s*\*\s*60\s*\*\s*1000\s*\}/);
  assert.match(trayContext, /_syncTimer\.Tick \+= \(_, _\) => TriggerBackgroundSync\(\)/);
  assert.match(
    trayContext,
    /ServerStatus\.Running[\s\S]*_syncTimer\.Start\(\);[\s\S]*TriggerBackgroundSync\(\);/,
  );
  assert.match(serverManager, /public void TriggerBackgroundSync\(\)[\s\S]*StartSync\(auto: true\);/);
  assert.match(
    serverManager,
    /auto\s*\?\s*new\[\]\s*\{\s*"sync",\s*"--auto",\s*"--background"\s*\}\s*:\s*new\[\]\s*\{\s*"sync"\s*\}/,
  );
  assert.doesNotMatch(serverManager, /new\[\]\s*\{\s*"sync",\s*"--auto"\s*\}/);
});
