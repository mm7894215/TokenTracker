const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const updateCheckerPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "UpdateChecker.swift",
);

function readUpdateChecker() {
  return fs.readFileSync(updateCheckerPath, "utf8");
}

function extractPresentAlert(source) {
  const start = source.indexOf("private func presentAlert");
  const end = source.indexOf("private final class BumpAttempts");

  assert.notEqual(start, -1, "UpdateChecker should define presentAlert().");
  assert.notEqual(end, -1, "UpdateChecker should keep BumpAttempts after presentAlert().");

  return source.slice(start, end);
}

test("update alerts restore the previous activation policy after closing", () => {
  const source = readUpdateChecker();
  const presentAlert = extractPresentAlert(source);

  assert.match(
    presentAlert,
    /let\s+previousActivationPolicy\s*=\s*NSApp\.activationPolicy\(\)/,
    "presentAlert should capture the activation policy before promoting the app for a modal alert.",
  );
  assert.match(
    presentAlert,
    /NSApp\.setActivationPolicy\(\.regular\)/,
    "presentAlert should still promote the menu-bar app so the native alert is visible.",
  );
  assert.match(
    presentAlert,
    /let\s+response\s*=\s*alert\.runModal\(\)[\s\S]*NSApp\.setActivationPolicy\(previousActivationPolicy\)[\s\S]*completion\(response\)/,
    "Closing the update alert should restore the prior policy so an open Dashboard window stays active.",
  );
  assert.doesNotMatch(
    presentAlert,
    /NSApp\.setActivationPolicy\(\.accessory\)/,
    "presentAlert must not always switch back to accessory mode; that can hide or deactivate the Dashboard window.",
  );
});
