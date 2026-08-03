const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const controllerSource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Services/DynamicIslandController.swift",
  ),
  "utf8",
);

const viewSource = fs.readFileSync(
  path.join(
    __dirname,
    "../TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift",
  ),
  "utf8",
);

test("the whole island rect owns hover, including the empty notch center", () => {
  assert.match(
    controllerSource,
    /return super\.hitTest\(point\) \?\? self/,
    "the AppKit container must claim empty points inside the island rect",
  );
  assert.match(
    controllerSource,
    /NSTrackingArea\(/,
    "the AppKit container must track hover independently of SwiftUI content",
  );
  assert.match(
    controllerSource,
    /override func mouseEntered[\s\S]*?handleHover\(true\)/,
    "entering any part of the island rect must expand it",
  );
  assert.match(
    controllerSource,
    /override func mouseExited[\s\S]*?handleHover\(false\)/,
    "leaving the island rect must schedule collapse",
  );
  assert.doesNotMatch(
    viewSource,
    /\.onHover\(perform: onHoverChanged\)/,
    "SwiftUI content bounds must not be the authoritative island hover source",
  );
});
