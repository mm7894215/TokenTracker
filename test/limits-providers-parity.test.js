const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// The macOS app and the dashboard each keep their own canonical list of
// usage-limits provider ids. The native bridge syncs preference snapshots
// keyed by these ids, so the two lists must stay identical — same ids, same
// default order — or visibility/order entries silently drop on one side.

const repoRoot = path.join(__dirname, "..");

function extractQuotedList(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} literal not found — update the parity test pattern`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("macOS LimitsSettingsStore.allProviders matches dashboard LIMIT_PROVIDER_IDS", () => {
  const swiftSource = fs.readFileSync(
    path.join(repoRoot, "TokenTrackerBar", "TokenTrackerBar", "Models", "LimitsSettingsStore.swift"),
    "utf8",
  );
  const jsSource = fs.readFileSync(
    path.join(repoRoot, "dashboard", "src", "lib", "limits-providers.js"),
    "utf8",
  );

  const swiftIds = extractQuotedList(
    swiftSource,
    /static let allProviders: \[String\] = \[([^\]]+)\]/,
    "LimitsSettingsStore.allProviders",
  );
  const jsIds = extractQuotedList(
    jsSource,
    /export const LIMIT_PROVIDER_IDS = \[([^\]]+)\]/s,
    "LIMIT_PROVIDER_IDS",
  );

  assert.ok(swiftIds.length > 0, "provider lists must not be empty");
  assert.deepEqual(swiftIds, jsIds);
});
