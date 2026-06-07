const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const nativeBridgePath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "NativeBridge.swift",
);

test("NativeBridge pushes settings when sync state changes", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  assert.match(
    source,
    /"isSyncing":\s*viewModel\?\.isSyncing\s*\?\?\s*false/,
    "settings payload should expose the current sync state",
  );
  assert.match(
    source,
    /viewModel\.\$isSyncing[\s\S]*?\.sink\s*\{\s*\[weak self\]\s*_\s*in\s*self\?\.pushSettings\(\)\s*\}/,
    "sync state changes should be pushed to the dashboard settings UI",
  );
});

test("NativeBridge settings fingerprint tracks available menu items", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  assert.match(
    source,
    /viewModel\.\$usageLimits[\s\S]*?\.map\s*\{\s*Self\.availableItemsFingerprint\(for:\s*\$0\)\s*\}/,
    "usage limit updates should be fingerprinted by the actual available menu items",
  );
  assert.match(
    source,
    /private static func availableItemsFingerprint[\s\S]*?MenuBarDisplayPreferences\.availableItemsPayload\(for:\s*limits\)[\s\S]*?\.compactMap\s*\{\s*\$0\["id"\]\s*\}[\s\S]*?\.joined\(separator:\s*"\|"\)/,
    "fingerprint should share availableItemsPayload so per-window data changes refresh the settings dropdown",
  );
  assert.doesNotMatch(
    source,
    /flag\(limits\.[a-zA-Z?]+\.configured/,
    "fingerprint must not collapse to provider availability only",
  );
});
