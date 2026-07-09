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
  const didCloseStart = source.indexOf("forName: NSPopover.didCloseNotification");
  const didCloseEnd = source.indexOf("// MARK: - Click Handling");
  const didCloseObserver = source.slice(didCloseStart, didCloseEnd);

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
    /if\s+popover\.isShown\s*\{\s*closePopoverIfShown\(\)\s*return\s*\}/,
    "Left-click toggling should use the same synchronous close cleanup path as other close triggers.",
  );
  assert.match(
    didCloseObserver,
    /queue:\s*\.main/,
    "The did-close cleanup uses MainActor.assumeIsolated, so the observer must run on the main queue.",
  );
  assert.match(
    source,
    /forName:\s*NSPopover\.didCloseNotification[\s\S]*object:\s*popover[\s\S]*\)\s*\{\s*\[weak self\]\s+_\s+in\s*MainActor\.assumeIsolated\s*\{\s*self\?\.handlePopoverDidClose\(\)\s*\}/,
    "The popover did-close observer should clean up synchronously on the main actor before the next open can reuse the anchor window.",
  );
  assert.doesNotMatch(
    didCloseObserver,
    /Task\s*\{\s*@MainActor/,
    "The did-close cleanup must not be deferred through an unstructured MainActor task.",
  );
  assert.match(
    source,
    /Task\s*\{\s*await\s+viewModel\.refreshForPopoverOpen\(\)\s*\}/,
    "Opening the popover should run the throttled lightweight sync path before reloading dashboard data.",
  );
  assert.doesNotMatch(
    source,
    /Task\s*\{\s*await\s+viewModel\.loadAll\(\)\s*\}/,
    "Opening the popover should not only reload cached dashboard data.",
  );

  const viewModelPath = path.join(
    __dirname,
    "..",
    "TokenTrackerBar",
    "TokenTrackerBar",
    "ViewModels",
    "DashboardViewModel.swift",
  );
  const viewModel = fs.readFileSync(viewModelPath, "utf8");
  assert.match(
    viewModel,
    /shouldRunPopoverOpenLoad\([\s\S]*lastRefreshed/,
    "When popover sync is throttled, dashboard reload should also be debounced by lastRefreshed.",
  );
  assert.match(
    viewModel,
    /guard\s+!isLoading\s+else\s*\{\s*shouldReloadAfterCurrentLoad\s*=\s*true\s*return\s*\}/,
    "Concurrent dashboard reload requests should queue one follow-up load instead of being dropped.",
  );
  assert.match(
    viewModel,
    /private\s+func\s+runQueuedReloadIfNeeded\(\)\s+async[\s\S]*shouldReloadAfterCurrentLoad\s*=\s*false[\s\S]*await\s+loadAll\(\)/,
    "A queued reload should run after the current load finishes so sync-now can refresh stale data.",
  );
});
