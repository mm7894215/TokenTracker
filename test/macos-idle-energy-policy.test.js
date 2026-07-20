const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

test("hidden companion cancels discrete animation tasks", () => {
  const source = fs.readFileSync(
    path.join(root, "TokenTrackerBar", "TokenTrackerBar", "Views", "ClawdCompanionView.swift"),
    "utf8",
  );

  assert.match(source, /\.onChange\(of: isCharacterTimelineVisible\)/);
  assert.match(source, /private func stopDiscreteAnimationLoops\(\)/);
  assert.match(source, /blinkTask\?\.cancel\(\)/);
  assert.match(source, /idleVariantTask\?\.cancel\(\)/);
  assert.doesNotMatch(
    source,
    /private func startBlinkLoop\(\)[\s\S]*?DispatchQueue\.main\.asyncAfter[\s\S]*?private func updateDiscreteAnimationLoops/,
  );
});

test("owned embedded server uses the low-frequency health-check policy", () => {
  const manager = fs.readFileSync(
    path.join(root, "TokenTrackerBar", "TokenTrackerBar", "Services", "ServerManager.swift"),
    "utf8",
  );
  const policy = fs.readFileSync(
    path.join(root, "TokenTrackerBar", "TokenTrackerBar", "Models", "ServerHealthCheckPolicy.swift"),
    "utf8",
  );

  assert.match(manager, /startHealthCheckLoop\(ownership: \.ownedProcess\)/);
  assert.match(manager, /ServerHealthCheckPolicy\.interval\(for: ownership\)/);
  assert.match(policy, /ownedProcessInterval: TimeInterval = 5 \* 60/);
  assert.match(policy, /externalProcessInterval: TimeInterval = 30/);
});
