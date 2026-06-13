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

  assert.match(
    apiClient,
    /func triggerSync\(drain: Bool = false\) async throws -> SyncResponse/,
    "APIClient should expose an explicit drain option with a lightweight default",
  );
  assert.match(
    apiClient,
    /body:\s*drain\s*\?\s*Data\(#"\{"drain":true\}"#\.utf8\)\s*:\s*Data\("\{}"\.utf8\)/,
    "APIClient should send drain=true only when requested",
  );
  assert.match(
    viewModel,
    /func syncThenLoad\(\)[\s\S]*APIClient\.shared\.triggerSync\(\)/,
    "initial launch sync should keep the lightweight default",
  );
  assert.match(
    viewModel,
    /func triggerSync\(\)[\s\S]*APIClient\.shared\.triggerSync\(drain: true\)/,
    "manual Sync now should request drain",
  );
});
