const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

test("macOS Sync Now combines a lightweight scan with cloud drain", () => {
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
    /if drain \{[\s\S]*"auto":true,"background":true,"allLocalSources":true,"publishAccount":true,"drain":true[\s\S]*\} else if auto \{[\s\S]*"auto":true,"background":true,"allLocalSources":true,"publishAccount":true/,
    "Sync Now should keep the bounded all-source scan while draining cloud uploads",
  );
  assert.match(
    viewModel,
    /func syncThenLoad\(silent: Bool = false\)[\s\S]*APIClient\.shared\.triggerSync\(auto: true\)/,
    "initial/background sync should use the auto path",
  );
  assert.match(
    viewModel,
    /private func performManualSync\(\)[\s\S]*APIClient\.shared\.triggerSync\(drain: true\)/,
    "manual Sync now should request drain",
  );
  assert.match(
    viewModel,
    /case \.queueAfterSilentSync:[\s\S]*pendingManualSync = true[\s\S]*isSyncing = true/,
    "a tap during silent popover sync should stay visible and queue one manual refresh",
  );
  assert.match(
    viewModel,
    /if pendingManualSync \{[\s\S]*pendingManualSync = false[\s\S]*await performManualSync\(\)/,
    "the queued manual refresh should run after the silent sync releases ownership",
  );
  assert.match(
    refreshPolicy,
    /static let defaultSyncInterval: TimeInterval = 300/,
    "background sync should run every 5 minutes instead of waiting 30 minutes",
  );
});
