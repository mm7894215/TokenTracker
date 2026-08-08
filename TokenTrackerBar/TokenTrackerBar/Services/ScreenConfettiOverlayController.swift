import AppKit
import SwiftUI
import Vortex

/// Full-screen celebration: a two-stage firework (rocket rises → bursts on death,
/// with sparkle trails) built on the Vortex particle library — the same engine
/// CodexBar builds its celebration on. An optional text toast names what reset.
///
/// Each screen gets a borderless, click-through `NSPanel` floating at the
/// status-bar level across all Spaces. Panels never take focus or mouse events,
/// so the user keeps working underneath. The show tears itself down after a few
/// seconds.
@MainActor
final class ScreenConfettiOverlayController {

    private var panels: [NSPanel] = []
    private var dismissTask: Task<Void, Never>?
    private var sleepObservers: [NSObjectProtocol] = []
    private let lifetime: TimeInterval = 9.0

    init() {
        registerSleepTeardownObservers()
    }

    deinit {
        let notificationCenter = NSWorkspace.shared.notificationCenter
        for observer in sleepObservers {
            notificationCenter.removeObserver(observer)
        }
    }

    /// Present either part of the reset feedback independently. `message`, when
    /// present and enabled, is shown as a fading toast alongside the provider icon.
    func play(
        message: String?,
        provider: String?,
        showsToast: Bool,
        showsConfetti: Bool
    ) {
        guard showsToast || showsConfetti else { return }
        guard panels.isEmpty else { return }            // already celebrating — ignore re-entry
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return }

        for screen in screens {
            let panel = makePanel(for: screen)
            // Fireworks span every display, so the context must be visible on every
            // display too. Otherwise a user working on a secondary screen sees the
            // celebration but not which provider/window reset.
            let host = NSHostingView(rootView: FireworkOverlayView(
                message: message,
                provider: provider,
                showsToast: showsToast,
                showsConfetti: showsConfetti
            ))
            host.frame = CGRect(origin: .zero, size: screen.frame.size)
            host.wantsLayer = true
            host.layer?.backgroundColor = NSColor.clear.cgColor
            panel.contentView = host
            panel.orderFrontRegardless()
            panels.append(panel)
        }

        dismissTask = Task { [weak self, lifetime] in
            try? await Task.sleep(nanoseconds: UInt64(lifetime * 1_000_000_000))
            self?.dismiss()
        }
    }

    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        for panel in panels {
            panel.orderOut(nil)
            panel.close()
        }
        panels.removeAll()
    }

    private func makePanel(for screen: NSScreen) -> NSPanel {
        let panel = ClickThroughPanel(
            contentRect: screen.frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.setFrame(screen.frame, display: false)
        return panel
    }

    /// A celebration is a ~9 second transient, so sleeping the machine or the
    /// displays mid-show means nobody is watching it anyway — end it immediately.
    /// This also keeps the particle simulation bounded: `TimelineView` stops
    /// ticking while asleep, and Vortex derives its per-frame delta from the wall
    /// clock, so the first frame after wake would advance the simulation by the
    /// entire sleep duration. See `makeFireworksSystem()` for why a large delta
    /// is expensive rather than merely wrong.
    private func registerSleepTeardownObservers() {
        let notificationCenter = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            let observer = notificationCenter.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.dismiss() }
            }
            sleepObservers.append(observer)
        }
    }
}

/// Builds a **fresh, privately owned** fireworks system for a single overlay view.
///
/// Vortex ships this configuration as `VortexSystem.fireworks`, but that is a
/// `static let` on a *class*, i.e. one mutable simulation object shared by the
/// whole process. Handing it to `VortexView` caused issue #432:
///
/// * When a celebration ends the view is removed, but the singleton keeps its
///   `particles`, its live `activeSecondarySystems`, and its `lastUpdate` stamp.
/// * The next celebration re-mounts that same object, so its first `update()`
///   resumes the leaked sub-systems with `delta` equal to the *entire gap*
///   between the two celebrations.
/// * `createParticles()` then loops `birthRate * delta` times — the emission
///   limit is only checked inside the loop body, so it does not bound the loop.
///   A leaked explosion system at 100_000 particles/second over a few hours is
///   billions of iterations on the main thread inside `Canvas`, which is exactly
///   the multi-second hang in the reported spindump.
/// * As a bonus the shared `emissionCount` never reset, so once the cumulative
///   1000-rocket emission limit was reached the fireworks stopped rendering
///   entirely until the app was relaunched.
///
/// A per-view system keeps every celebration independent, and also stops the
/// multi-display case (one `VortexView` per screen) from driving one simulation
/// object several times per frame.
private func makeFireworksSystem() -> VortexSystem {
    let sparkles = VortexSystem(
        tags: ["circle"],
        spawnOccasion: .onUpdate,
        emissionLimit: 1,
        lifespan: 0.5,
        speed: 0.05,
        angleRange: .degrees(90),
        size: 0.05
    )

    let explosion = VortexSystem(
        tags: ["circle"],
        spawnOccasion: .onDeath,
        position: [0.5, 1],
        // Vortex's preset uses 100_000 here purely to mean "instantly". Because
        // `createParticles()` iterates `birthRate * delta` times regardless of
        // `emissionLimit`, that number is also the multiplier on any long frame
        // delta. One emission limit's worth per frame at the 60fps `VortexView`
        // renders at is just as instant and bounds the worst case ~3 orders of
        // magnitude lower.
        birthRate: Double(fireworksExplosionEmissionLimit * 60),
        emissionLimit: fireworksExplosionEmissionLimit,
        speed: 0.5,
        speedVariation: 1,
        angleRange: .degrees(360),
        acceleration: [0, 1.5],
        dampingFactor: 4,
        colors: .randomRamp(
            [.white, .pink, .pink],
            [.white, .blue, .blue],
            [.white, .green, .green],
            [.white, .orange, .orange],
            [.white, .cyan, .cyan]
        ),
        size: 0.15,
        sizeVariation: 0.1,
        sizeMultiplierAtDeath: 0
    )

    return VortexSystem(
        tags: ["circle"],
        secondarySystems: [sparkles, explosion],
        position: [0.5, 1],
        birthRate: 2,
        emissionLimit: 1000,
        speed: 1.5,
        speedVariation: 0.75,
        angleRange: .degrees(60),
        dampingFactor: 2,
        size: 0.15,
        stretchFactor: 4
    )
}

/// Particles in a single rocket burst.
private let fireworksExplosionEmissionLimit = 500

/// Borderless panel that never steals focus or mouse — a transparent overlay.
private final class ClickThroughPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override var acceptsFirstResponder: Bool { false }
}

/// Vortex fireworks + an optional fading toast banner near the top.
private struct FireworkOverlayView: View {
    let message: String?
    let provider: String?
    let showsToast: Bool
    let showsConfetti: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var toastShown = false
    @State private var fireworksShown = true
    /// Owned by this view, never shared: see `makeFireworksSystem()`.
    @State private var fireworks: VortexSystem = makeFireworksSystem()
    private let fireworksDuration: TimeInterval = 5.0
    private let toastFadeDelay: TimeInterval = 8.0

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if showsConfetti && fireworksShown {
                VortexView(fireworks)
                    .transition(.opacity)
                    .allowsHitTesting(false)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + fireworksDuration) {
                            withAnimation(.easeOut(duration: 0.5)) { fireworksShown = false }
                        }
                    }
            }

            if showsToast, let message {
                HStack(spacing: 10) {
                    LimitResetProviderIcon(provider: provider)

                    Text(message)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(.white.opacity(0.16), lineWidth: 0.5)
                    )
                    .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
                    .padding(.horizontal, 16)
                    .padding(.top, 52)
                    .opacity(toastShown ? 1 : 0)
                    .scaleEffect(reduceMotion ? 1 : (toastShown ? 1 : 0.96))
                    .offset(y: reduceMotion ? 0 : (toastShown ? 0 : -10))
                    .blur(radius: reduceMotion ? 0 : (toastShown ? 0 : 3))
                    .allowsHitTesting(false)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(message)
                    .onAppear {
                        let entrance: Animation = reduceMotion
                            ? .easeOut(duration: 0.2)
                            : .spring(response: 0.48, dampingFraction: 0.86)
                        withAnimation(entrance) { toastShown = true }
                        DispatchQueue.main.asyncAfter(deadline: .now() + toastFadeDelay) {
                            withAnimation(.easeInOut(duration: 0.45)) { toastShown = false }
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Provider artwork used by the reset toast. Some brands ship in the asset
/// catalog while the remaining providers reuse the bundled dashboard SVGs.
struct LimitResetProviderIcon: View {
    let provider: String?

    var body: some View {
        Group {
            if let provider, let assetName = LimitResetProviderIconCatalog.assetName(for: provider) {
                Image(assetName)
                    .renderingMode(.original)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else if let provider,
                      let filename = LimitResetProviderIconCatalog.svgFilename(for: provider),
                      let image = Self.bundledSVGIcon(named: filename) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "arrow.clockwise.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.mint)
            }
        }
        .frame(width: 24, height: 24)
        .environment(\.colorScheme, .dark)
        .accessibilityHidden(true)
    }

    private static func bundledSVGIcon(named filename: String) -> NSImage? {
        guard let url = Bundle.main.resourceURL?
            .appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\(filename)"),
              var svg = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }

        // Dashboard SVGs use currentColor; the celebration toast has a dark
        // background, so render monochrome provider artwork in white.
        svg = svg.replacingOccurrences(of: "currentColor", with: "#FFFFFF")
        guard let data = svg.data(using: .utf8),
              let image = NSImage(data: data) else { return nil }
        image.isTemplate = false
        return image
    }
}
