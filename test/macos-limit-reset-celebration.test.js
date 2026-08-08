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

test("each overlay view owns its particle system instead of Vortex's shared preset", () => {
  const source = overlaySource();

  assert.doesNotMatch(
    source,
    /VortexView\(\s*(VortexSystem)?\.fireworks/,
    "VortexSystem.fireworks is a static let on a class, so sharing it leaks particles, live secondary systems and a stale lastUpdate between celebrations (issue #432).",
  );
  assert.match(source, /private func makeFireworksSystem\(\) -> VortexSystem/);
  assert.match(
    source,
    /@State private var fireworks: VortexSystem = makeFireworksSystem\(\)/,
    "The system must be created per view so multi-display panels do not drive one simulation object.",
  );
  assert.match(source, /VortexView\(fireworks\)/);
});

test("fireworks explosion birth rate stays bounded by its emission limit", () => {
  const source = overlaySource();
  const burst = Number(source.match(/fireworksExplosionEmissionLimit\s*=\s*(\d+)/)?.[1]);

  assert.ok(Number.isFinite(burst), "The burst size should be an explicit testable constant.");
  assert.match(
    source,
    /birthRate: Double\(fireworksExplosionEmissionLimit \* 60\)/,
    "createParticles() loops birthRate * delta times regardless of emissionLimit, so the birth rate multiplies any long frame delta.",
  );
  assert.doesNotMatch(
    source,
    /birthRate:\s*100_000/,
    "Vortex's preset birth rate turns a multi-hour delta into billions of main-thread loop iterations.",
  );
  assert.ok(
    burst * 60 <= 60_000,
    `Explosion birth rate should stay far below the 100_000 preset, got ${burst * 60}.`,
  );
});

test("celebration tears itself down when the machine or displays sleep", () => {
  const source = overlaySource();

  assert.match(source, /registerSleepTeardownObservers\(\)/);
  assert.match(source, /NSWorkspace\.willSleepNotification/);
  assert.match(
    source,
    /NSWorkspace\.screensDidSleepNotification/,
    "Sleep pauses TimelineView but not the wall clock, so the first frame after wake would advance the simulation by the whole sleep.",
  );
  assert.match(source, /self\?\.dismiss\(\)/);
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
