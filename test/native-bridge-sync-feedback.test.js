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

test("NativeBridge pushes settings when update checker status changes", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  assert.match(
    source,
    /"updateStatus":\s*UpdateChecker\.shared\.statusText\s*\?\?\s*NSNull\(\)/,
    "settings payload should expose the current update checker status text",
  );
  assert.match(
    source,
    /"updateBusy":\s*UpdateChecker\.shared\.isBusy/,
    "settings payload should expose whether the update checker is busy",
  );
  assert.match(
    source,
    /NotificationCenter\.default\.publisher\(for:\s*\.updateCheckerStatusDidChange\)[\s\S]*?\.sink\s*\{\s*\[weak self\]\s*_\s*in\s*self\?\.pushSettings\(\)\s*\}/,
    "update checker status changes should be pushed to the dashboard settings UI",
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
    /private static func availableItemsFingerprint[\s\S]*?MenuBarDisplayPreferences\.availableItemIDs\(\s*for:\s*limits,\s*keepingSelected:\s*MenuBarDisplayPreferences\.read\(\),\s*hiddenProviders:\s*LimitsSettingsStore\.shared\.hiddenProviders\s*\)[\s\S]*?\.joined\(separator:\s*"\|"\)/,
    "fingerprint should use the same available ids as the settings payload without building full dictionaries",
  );
  assert.doesNotMatch(
    source,
    /availableItemsFingerprint[\s\S]*?availableItemsPayload\([\s\S]*?compactMap\s*\{\s*\$0\["id"\]\s*\}/,
    "fingerprint should not construct full available item payload dictionaries",
  );
  assert.doesNotMatch(
    source,
    /flag\(limits\.[a-zA-Z?]+\.configured/,
    "fingerprint must not collapse to provider availability only",
  );
});

test("NativeBridge self-heals saved menu bar selections against available items", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  assert.match(
    source,
    /let\s+availableItemIDs\s*=\s*MenuBarDisplayPreferences\.availableItemIDs\(\s*for:\s*viewModel\?\.usageLimits,\s*keepingSelected:\s*menuBarItems,\s*hiddenProviders:\s*hiddenProviders\s*\)/,
    "pushSettings should compute the current selectable ids from usage limits and hidden providers",
  );
  assert.match(
    source,
    /let\s+normalizedMenuBarItems\s*=\s*MenuBarDisplayPreferences\.normalize\(\s*menuBarItems,\s*allowedIDs:\s*Set\(availableItemIDs\)\s*\)/,
    "saved menu-bar ids should be normalized against selectable ids",
  );
  // Regression (2026-06 audit): pushSettings must NOT persist the
  // availability-pruned selection. Availability is transient — a single 4xx
  // from a provider yields a "healthy but windowless" limits response, and
  // persisting the prune permanently erased the user's saved metric
  // selection. The payload is filtered; the stored selection stays intact
  // (MenuBarDisplayPreferences.read() still self-heals junk ids against the
  // full metric universe).
  assert.doesNotMatch(
    source,
    /if\s+normalizedMenuBarItems\s*!=\s*menuBarItems\s*\{[\s\S]*?MenuBarDisplayPreferences\.write\(normalizedMenuBarItems\)/,
    "pushSettings must not persist availability-pruned menu bar selections",
  );
  assert.match(
    source,
    /"menuBarItems":\s*normalizedMenuBarItems/,
    "settings payload should expose the availability-filtered selection",
  );
});
