const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("macOS manual Sync now requests drain while launch sync stays lightweight", () => {
  const apiClient = read("TokenTrackerBar/TokenTrackerBar/Services/APIClient.swift");
  const viewModel = read("TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift");
  const refreshPolicy = read("TokenTrackerBar/TokenTrackerBar/Models/BackgroundRefreshPolicy.swift");

  assert.match(
    apiClient,
    /func triggerSync\(drain: Bool = false, auto: Bool = false\) async throws -> SyncResponse/,
    "APIClient should expose explicit drain and auto options with a lightweight default",
  );
  assert.match(
    apiClient,
    /if drain \{[\s\S]*Data\(#"\{"drain":true\}"#\.utf8\)[\s\S]*\} else if auto \{[\s\S]*Data\([\s\S]*#"\{"auto":true,"background":true,"allLocalSources":true,"publishAccount":true\}"#\.utf8/,
    "APIClient should send drain=true for manual sync and publish all local sources for background sync",
  );
  assert.match(
    viewModel,
    /func syncThenLoad\(silent: Bool = false\)[\s\S]*APIClient\.shared\.triggerSync\(auto: true\)/,
    "initial/background sync should use the auto path",
  );
  assert.match(
    viewModel,
    /func triggerSync\(\)[\s\S]*APIClient\.shared\.triggerSync\(drain: true\)/,
    "manual Sync now should request drain",
  );
  assert.match(
    refreshPolicy,
    /static let defaultSyncInterval: TimeInterval = 300/,
    "background sync should run every 5 minutes instead of waiting 30 minutes",
  );
});
