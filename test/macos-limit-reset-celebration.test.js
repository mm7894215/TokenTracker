const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const overlayPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "ScreenConfettiOverlayController.swift",
);
const resetDetectorPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Models",
  "WeeklyLimitResetDetector.swift",
);
const statusBarControllerPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "StatusBarController.swift",
);
const nativeBridgePath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "NativeBridge.swift",
);
const limitsSettingsViewPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Views",
  "LimitsSettingsView.swift",
);

function overlaySource() {
  return fs.readFileSync(overlayPath, "utf8");
}

test("limit-reset toast and confetti use independent durable preferences", () => {
  const detector = fs.readFileSync(resetDetectorPath, "utf8");
  const statusBar = fs.readFileSync(statusBarControllerPath, "utf8");
  const nativeBridge = fs.readFileSync(nativeBridgePath, "utf8");
  const settingsView = fs.readFileSync(limitsSettingsViewPath, "utf8");

  assert.match(detector, /toastEnabledKey\s*=\s*"LimitsToastOnResetEnabled"/);
  assert.match(detector, /toastEnabledDefault\s*=\s*true/);
  assert.match(detector, /static func toastEnabled\(/);
  assert.match(
    statusBar,
    /let showsToast = WeeklyLimitResetDetector\.toastEnabled\(\)[\s\S]*let showsConfetti = WeeklyLimitResetDetector\.confettiEnabled\(\)[\s\S]*guard showsToast \|\| showsConfetti else \{ return \}/,
  );
  assert.match(
    statusBar,
    /confettiController\.play\([\s\S]*showsToast: showsToast,[\s\S]*showsConfetti: showsConfetti/,
  );
  assert.doesNotMatch(
    statusBar,
    /guard WeeklyLimitResetDetector\.confettiEnabled\(\) else \{ return \}/,
    "Turning off confetti must not suppress the reset toast.",
  );
  assert.match(nativeBridge, /"toastOnReset": WeeklyLimitResetDetector\.toastEnabled\(\)/);
  assert.match(nativeBridge, /case "toastOnReset":[\s\S]*WeeklyLimitResetDetector\.toastEnabledKey/);
  assert.match(settingsView, /@AppStorage\(WeeklyLimitResetDetector\.toastEnabledKey\)/);
  assert.match(settingsView, /Text\(Strings\.toastOnResetLabel\)/);
});

test("overlay can render toast and fireworks independently", () => {
  const source = overlaySource();

  assert.match(source, /func play\([\s\S]*showsToast: Bool,[\s\S]*showsConfetti: Bool/);
  assert.match(source, /guard showsToast \|\| showsConfetti else \{ return \}/);
  assert.match(source, /if showsConfetti && fireworksShown/);
  assert.match(source, /if showsToast, let message/);
});

test("limit-reset toast is rendered on every fireworks screen", () => {
  const source = overlaySource();

  assert.doesNotMatch(
    source,
    /screen\s*==\s*NSScreen\.main/,
    "A secondary display must not get fireworks without the reset message.",
  );
  assert.match(
    source,
    /for screen in screens[\s\S]*FireworkOverlayView\([\s\S]*message: message,[\s\S]*provider: provider,[\s\S]*showsToast: showsToast,[\s\S]*showsConfetti: showsConfetti/,
    "Every screen panel should receive the same reset message and provider icon.",
  );
});

test("limit-reset toast renders the triggering provider icon", () => {
  const source = overlaySource();

  assert.match(source, /LimitResetProviderIcon\(provider: provider\)/);
  assert.match(source, /LimitResetProviderIconCatalog\.assetName\(for: provider\)/);
  assert.match(source, /LimitResetProviderIconCatalog\.svgFilename\(for: provider\)/);
  assert.match(source, /\.frame\(width: 24, height: 24\)/);
  assert.match(source, /\.font\(\.system\(size: 15, weight: \.semibold, design: \.rounded\)\)/);
  assert.match(source, /\.spring\(response: 0\.48, dampingFraction: 0\.86\)/);
  assert.match(source, /accessibilityReduceMotion/);
  assert.match(source, /\.environment\(\\\.colorScheme, \.dark\)/);
  assert.match(source, /replacingOccurrences\(of: "currentColor", with: "#FFFFFF"\)/);
  assert.doesNotMatch(source, /\.title2/);
});

test("limit-reset toast stays readable for most of the fireworks lifetime", () => {
  const source = overlaySource();
  const lifetime = Number(source.match(/lifetime:\s*TimeInterval\s*=\s*([\d.]+)/)?.[1]);
  const fireworksDuration = Number(source.match(/fireworksDuration:\s*TimeInterval\s*=\s*([\d.]+)/)?.[1]);
  const fadeDelay = Number(source.match(/toastFadeDelay:\s*TimeInterval\s*=\s*([\d.]+)/)?.[1]);

  assert.ok(Number.isFinite(lifetime), "The overlay lifetime should be an explicit testable constant.");
  assert.ok(Number.isFinite(fireworksDuration), "The fireworks duration should be an explicit testable constant.");
  assert.ok(Number.isFinite(fadeDelay), "The toast fade delay should be an explicit testable constant.");
  assert.ok(fireworksDuration <= 5.5, `Fireworks should finish promptly, got ${fireworksDuration}.`);
  assert.ok(fadeDelay > fireworksDuration, "The toast should remain after the fireworks end.");
  assert.ok(fadeDelay >= 7.5, `Toast should remain visible for at least 7.5 seconds, got ${fadeDelay}.`);
  assert.ok(fadeDelay < lifetime, "Toast should begin fading before the overlay panel is dismissed.");
});
