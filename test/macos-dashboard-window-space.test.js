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
const appDelegatePath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "TokenTrackerBarApp.swift",
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

test("reopening the macOS menu bar app always restores the dashboard", () => {
  const source = read(appDelegatePath);
  const reopenHandler = source.match(
    /func applicationShouldHandleReopen\([\s\S]*?\n    }/,
  )?.[0];

  assert.ok(reopenHandler, "AppDelegate should handle Finder/Dock reopen events");
  assert.match(reopenHandler, /DashboardWindowController\.shared\.showWindow\(\)/);
  assert.match(
    reopenHandler,
    /return false/,
    "The custom reopen handler should suppress AppKit's default untitled-window behavior",
  );
  assert.doesNotMatch(
    reopenHandler,
    /if\s+!?flag|guard\s+!?flag/,
    "Other visible utility windows must not suppress dashboard restoration",
  );
});

test("a normal macOS launch opens the dashboard but a login-item launch stays quiet", () => {
  const source = read(appDelegatePath);
  const launchHandler = source.match(
    /func applicationDidFinishLaunching\([\s\S]*?\n    }\n\n    func applicationWillTerminate/,
  )?.[0];

  assert.ok(launchHandler, "AppDelegate should configure initial launch behavior");
  assert.match(launchHandler, /keyAELaunchedAsLogInItem/);
  assert.match(launchHandler, /DashboardWindowController\.shared\.showWindow\(\)/);
});
