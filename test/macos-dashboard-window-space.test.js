const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const dashboardWindowControllerPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DashboardWindowController.swift",
);
const desktopPetWindowControllerPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DesktopPetWindowController.swift",
);

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("macOS dashboard window can full-screen itself without joining other apps' full-screen spaces", () => {
  const source = read(dashboardWindowControllerPath);
  const behaviorMatch = source.match(/window\.collectionBehavior\s*=\s*\[([^\]]+)\]/);

  assert.ok(behaviorMatch, "Dashboard NSWindow should set an explicit collectionBehavior");

  const behavior = behaviorMatch[1];
  assert.match(behavior, /\.managed\b/, "Dashboard should participate in normal Spaces management");
  assert.match(behavior, /\.fullScreenPrimary\b/, "Dashboard should still be able to enter its own full-screen Space");
  assert.doesNotMatch(
    behavior,
    /\.canJoinAllSpaces|\.fullScreenAuxiliary|\.moveToActiveSpace/,
    "Dashboard should not float into or move to the currently active full-screen Space",
  );
  assert.doesNotMatch(
    source,
    /\.canJoinAllSpaces|\.fullScreenAuxiliary|\.moveToActiveSpace/,
    "DashboardWindowController should not add forbidden Space behavior elsewhere",
  );
});

test("macOS desktop pet keeps its intentional full-screen auxiliary behavior", () => {
  const source = read(desktopPetWindowControllerPath);
  const behaviorMatch = source.match(/panel\.collectionBehavior\s*=\s*\[([^\]]+)\]/);

  assert.ok(behaviorMatch, "Desktop pet NSPanel should set an explicit collectionBehavior");

  const behavior = behaviorMatch[1];
  assert.match(behavior, /\.canJoinAllSpaces\b/);
  assert.match(behavior, /\.fullScreenAuxiliary\b/);
});
