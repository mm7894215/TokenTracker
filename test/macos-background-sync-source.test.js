const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("macOS background sync sends auto background while Sync Now drains", () => {
  const apiClient = read("TokenTrackerBar/TokenTrackerBar/Services/APIClient.swift");
  const viewModel = read("TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift");
  const refreshPolicy = read("TokenTrackerBar/TokenTrackerBar/Models/BackgroundRefreshPolicy.swift");

  assert.match(
    apiClient,
    /func triggerSync\(drain: Bool = false, auto: Bool = false\) async throws -> SyncResponse/,
  );
  assert.match(
    apiClient,
    /if drain \{[\s\S]*Data\(#"\{"drain":true\}"#\.utf8\)[\s\S]*\} else if auto \{[\s\S]*Data\(#"\{"auto":true,"background":true\}"#\.utf8\)/,
  );
  assert.match(
    viewModel,
    /func syncThenLoad\(\)[\s\S]*APIClient\.shared\.triggerSync\(auto: true\)/,
  );
  assert.match(
    viewModel,
    /func triggerSync\(\)[\s\S]*APIClient\.shared\.triggerSync\(drain: true\)/,
  );
  assert.match(refreshPolicy, /static let defaultSyncInterval: TimeInterval = 300/);
});
