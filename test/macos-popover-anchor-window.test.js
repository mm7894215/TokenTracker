const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const statusBarControllerPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "StatusBarController.swift",
);

function readStatusBarController() {
  return fs.readFileSync(statusBarControllerPath, "utf8");
}

test("menu-bar popover is anchored to an app-owned positioning window", () => {
  const source = readStatusBarController();

  assert.match(
    source,
    /private\s+var\s+popoverAnchorWindow:\s*NSWindow\?/,
    "StatusBarController should keep an app-owned anchor window for stable popover positioning.",
  );
  assert.match(
    source,
    /private\s+func\s+makePopoverAnchorWindow\(\)\s*->\s*NSWindow[\s\S]*styleMask:\s*\[\.borderless\][\s\S]*collectionBehavior\s*=\s*\[[^\]]*\.canJoinAllSpaces[^\]]*\.fullScreenAuxiliary[^\]]*\.ignoresCycle[^\]]*\.stationary[^\]]*\]/,
    "The anchor window should be borderless, invisible, and allowed in full-screen Spaces.",
  );
  assert.match(
    source,
    /private\s+func\s+positionPopoverAnchorWindow\(under\s+button:\s*NSStatusBarButton\)\s*->\s*NSView\?[\s\S]*button\.window[\s\S]*convertToScreen[\s\S]*setFrame\(anchorFrame,\s*display:\s*false\)[\s\S]*orderFrontRegardless\(\)/,
    "The anchor window should be positioned from the clicked status button's screen rect before showing the popover.",
  );
  assert.match(
    source,
    /guard\s+let\s+anchorView\s*=\s*positionPopoverAnchorWindow\(under:\s*button\)[\s\S]*popover\.show\(relativeTo:\s*anchorView\.bounds,\s*of:\s*anchorView,\s*preferredEdge:\s*\.minY\)/,
    "The popover should show relative to the app-owned anchor view, not the system status button window.",
  );
  assert.match(
    source,
    /private\s+func\s+closePopoverIfShown\(\)\s*\{[\s\S]*if\s+popover\.isShown\s*\{[\s\S]*popover\.performClose\(nil\)[\s\S]*\}\s*popoverAnchorWindow\?\.orderOut\(nil\)/,
    "Closing the popover path should also hide the app-owned anchor window.",
  );
  assert.match(
    source,
    /forName:\s*NSPopover\.didCloseNotification[\s\S]*object:\s*popover[\s\S]*\)\s*\{\s*\[weak self\]\s+_\s+in[\s\S]*Task\s*\{\s*@MainActor\s*\[weak self\]\s+in[\s\S]*self\?\.popoverAnchorWindow\?\.orderOut\(nil\)[\s\S]*self\?\.updateStatsDisplay\(\)/,
    "The popover did-close observer should hide the app-owned anchor window before refreshing status display.",
  );
});
