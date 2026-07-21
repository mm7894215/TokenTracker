const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("Windows dashboard forwards the update CTA to the existing native updater", () => {
  const dashboardWindow = read("TokenTrackerWin/DashboardWindow.cs");
  const tray = read("TokenTrackerWin/TrayApplicationContext.cs");

  assert.match(dashboardWindow, /public event Action\? UpdateRequested;/);
  assert.match(dashboardWindow, /actionName\.GetString\(\) == "checkForUpdates"/);
  assert.match(dashboardWindow, /UpdateRequested\?\.Invoke\(\);/);
  assert.match(tray, /_dashboard\.UpdateRequested \+= \(\) => PostToUi\(OnCheckUpdatesClicked\);/);
});
