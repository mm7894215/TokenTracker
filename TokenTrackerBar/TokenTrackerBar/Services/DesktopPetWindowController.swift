import AppKit
import SwiftUI

/// A transparent, always-on-top, non-activating floating window that hosts the Clawd
/// companion as a desktop pet — the macOS counterpart of the Windows pet window
/// (PR #128). Where Windows had to host a WebView (no native Clawd renderer in .NET),
/// macOS hosts the native SwiftUI `ClawdCompanionView` directly and shares the app's
/// single `DashboardViewModel`, so the pet never polls independently and never drifts
/// from the menu bar.
@MainActor
final class DesktopPetWindowController: NSObject, NSWindowDelegate {
    /// Persists whether the user had the pet showing, so it returns on next launch.
    static let showDefaultsKey = "DesktopPetShow"
    private static let frameAutosaveName = "DesktopPetWindow"
    private static let sizeDefaultsKey = "DesktopPetSize"
    // Wide enough to fully contain the longest data bubble (e.g. "309.8M tokens —
    // $197.41 spent today"); the window is transparent so the extra width is invisible —
    // it just lets the centered bubble render without hitting the window edge (which
    // caused clipping → drift/flicker). The sprite stays centered in this width.
    // Width is fixed across all sizes (only the sprite scale + panel height change), so
    // the sprite always sits at the panel's horizontal center regardless of preset
    // (see PetSizePreset.panelWidth).
    /// Minimum on-screen width before the bubble is allowed. Below this — dragging the
    /// pet off the side, or tucked at an edge — the bubble is hidden so it never tries
    /// to render in a clipped width and flicker.
    private static let bubbleMinWidth: CGFloat = 300
    /// How much of the *sprite* peeks out when tucked against an edge.
    private static let edgePeek: CGFloat = 30
    /// A drag that ends within this distance of the left/right edge tucks the pet away.
    private static let snapMargin: CGFloat = 24

    /// Current size preset (persisted). Drives sprite scale, panel height, and the
    /// sprite-derived edge-tuck geometry below.
    private var sizePreset: PetSizePreset = .medium

    /// Panel size for the current preset — width fixed, height grows with scale so a
    /// larger sprite isn't clipped at the panel's top/bottom.
    private var petSize: NSSize { NSSize(width: PetSizePreset.panelWidth, height: sizePreset.panelHeight) }
    /// The sprite is horizontally centered in the (wider) panel; this mirrors
    /// ClawdCompanionView's floating layout — sprite = 15 * px(4) * scale — so tucking
    /// exposes the *sprite*, not the panel's transparent margin.
    private var spriteWidth: CGFloat { 60 * sizePreset.scale }
    private var spriteLeftInset: CGFloat { (PetSizePreset.panelWidth - spriteWidth) / 2 }

    private enum Edge { case left, right }

    private let viewModel: DashboardViewModel
    private var panel: NSPanel?
    private var dragMonitor: Any?
    private var upMonitor: Any?
    /// nil → freely placed; otherwise the edge the pet is tucked against.
    private var hiddenEdge: Edge?
    private var isRevealed = false
    private var didDrag = false
    private var sleepTimer: Timer? = nil
    /// Drives whether the floating bubble may show (enough of the pet is on-screen).
    let uiState = PetWindowState()

    init(viewModel: DashboardViewModel) {
        self.viewModel = viewModel
        if let raw = UserDefaults.standard.string(forKey: Self.sizeDefaultsKey),
           let saved = PetSizePreset(rawValue: raw) {
            sizePreset = saved
        }
        super.init()
        uiState.floatingScale = sizePreset.scale
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    func toggle() {
        if isVisible { hide() } else { show() }
    }

    func show() {
        let panel = panel ?? makePanel()
        self.panel = panel
        uiState.isWindowVisible = true
        panel.orderFrontRegardless()
        UserDefaults.standard.set(true, forKey: Self.showDefaultsKey)
        keepActive()
    }

    func hide() {
        panel?.orderOut(nil)
        uiState.isWindowVisible = false
        UserDefaults.standard.set(false, forKey: Self.showDefaultsKey)
        sleepTimer?.invalidate()
        sleepTimer = nil
    }

    /// Re-show the pet on launch if it was visible when the app last quit.
    func restoreIfNeeded() {
        if UserDefaults.standard.bool(forKey: Self.showDefaultsKey) { show() }
    }

    private func isFrameOnScreen(_ frame: NSRect) -> Bool {
        let spriteFrame = NSRect(
            x: frame.origin.x + spriteLeftInset,
            y: frame.origin.y,
            width: spriteWidth,
            height: frame.size.height
        )
        for screen in NSScreen.screens {
            if screen.visibleFrame.intersects(spriteFrame) {
                return true
            }
        }
        return false
    }

    private func makePanel() -> NSPanel {
        let size = petSize
        // Use a hosting *controller* (not a bare NSHostingView as contentView): on a
        // borderless panel the latter routes SwiftUI's per-frame invalidations into
        // -[NSWindow _postWindowNeedsUpdateConstraints], which throws and crashes. A
        // fixed-frame root keeps sizing deterministic so no constraint cycle runs.
        let hostingController = NSHostingController(
            rootView: DesktopPetHost(
                petState: uiState,
                content: ClawdCompanionView(
                    viewModel: viewModel,
                    layout: .floating,
                    onRequestDashboard: { DashboardWindowController.shared.showWindow() },
                    onClosePet: { [weak self] in self?.hide() },
                    onHoverChanged: { [weak self] hovering in self?.handleHover(hovering) },
                    onKeepActive: { [weak self] in self?.keepActive() },
                    onSetSize: { [weak self] preset in self?.setSize(preset) },
                    petState: uiState
                )
            )
        )

        let panel = PetPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hostingController
        // Transparent: only Clawd's opaque pixels (and the bubble material) show.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Float above normal windows, ride along to every Space / full-screen app,
        // and stay out of Cmd-Tab cycling. Never activate the app on click.
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.acceptsMouseMovedEvents = true

        // Restore the last drag position, or park near the bottom-right on first run.
        panel.setFrameAutosaveName(Self.frameAutosaveName)
        var restored = false
        if panel.setFrameUsingName(Self.frameAutosaveName) {
            if isFrameOnScreen(panel.frame) {
                restored = true
            }
        }
        if restored {
            // Keep only the restored ORIGIN — the saved size may be from a different
            // preset (or an older build), so force the current preset's size. NSWindow
            // origin is bottom-left, so a taller preset grows upward in place.
            var f = panel.frame
            f.size = size
            panel.setFrame(f, display: false)
        } else if let screen = NSScreen.main {
            let area = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: area.maxX - size.width - 40, y: area.minY + 60))
        }
        self.panel = panel
        panel.delegate = self
        // If the saved frame had it tucked against an edge, restore that tucked state
        // (so a hover still slides it out).
        detectTuckedState(panel)
        installDragMonitors(panel)
        updateBubbleAllowed()
        return panel
    }

    // MARK: - Bubble width gating

    func windowDidMove(_ notification: Notification) {
        updateBubbleAllowed()
        if let panel, didDrag {
            detectTuckedState(panel)
        }
    }

    /// Hide the bubble whenever too little of the pet is on-screen (edge-tucked, or being
    /// dragged off the side), so it never flickers trying to render in a clipped width.
    private func updateBubbleAllowed() {
        guard let panel, let screen = panel.screen ?? NSScreen.main else { return }
        let visibleW = panel.frame.intersection(screen.visibleFrame).width
        let allowed = visibleW >= Self.bubbleMinWidth
        if uiState.bubbleAllowed != allowed { uiState.bubbleAllowed = allowed }
    }

    // MARK: - Drag cursor + edge tucking

    private func installDragMonitors(_ panel: NSPanel) {
        // Closed-hand "grab" cursor while dragging the pet; restore the open hand on drop.
        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged]) { [weak self, weak panel] event in
            if event.window === panel {
                Task { @MainActor [weak self] in
                    self?.didDrag = true
                    NSCursor.closedHand.set()
                }
            }
            return event
        }
        upMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self, weak panel] event in
            if event.window === panel {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.keepActive()
                    if self.didDrag {            // only after a real drag, not a tap
                        NSCursor.openHand.set()
                        self.snapToEdgeIfNeeded()
                    }
                    self.didDrag = false
                }
            }
            return event
        }
    }

    /// On drop, tuck the pet away if it landed against the left/right edge.
    private func snapToEdgeIfNeeded() {
        guard let panel, let screen = panel.screen else { return }
        let vf = screen.visibleFrame
        let f = panel.frame
        let spriteLeft = f.origin.x + spriteLeftInset
        let spriteRight = spriteLeft + spriteWidth
        
        if spriteRight >= vf.maxX - Self.snapMargin {
            hiddenEdge = .right
            isRevealed = false
            uiState.isRightEdge = true
            uiState.isTucked = true
            uiState.isSnapped = true
            let targetX = vf.maxX - spriteLeftInset - Self.edgePeek
            Task {
                await animateWindowParabola(to: targetX, targetY: f.origin.y, duration: 0.35)
                panel.saveFrame(usingName: Self.frameAutosaveName)
            }
        } else if spriteLeft <= vf.minX + Self.snapMargin {
            hiddenEdge = .left
            isRevealed = false
            uiState.isRightEdge = false
            uiState.isTucked = true
            uiState.isSnapped = true
            let targetX = vf.minX + Self.edgePeek - (spriteLeftInset + spriteWidth)
            Task {
                await animateWindowParabola(to: targetX, targetY: f.origin.y, duration: 0.35)
                panel.saveFrame(usingName: Self.frameAutosaveName)
            }
        } else {
            hiddenEdge = nil
            uiState.isTucked = false
            uiState.isSnapped = false
        }
    }

    /// Hovering an edge-tucked pet slides it fully into view; leaving tucks it back.
    private func handleHover(_ hovering: Bool) {
        uiState.isHovered = hovering
        if hovering {
            keepActive()
        }
        guard hiddenEdge != nil else { return }
        if hovering, !isRevealed {
            isRevealed = true
            applyEdgeFrame(animated: true)
        } else if !hovering, isRevealed {
            isRevealed = false
            applyEdgeFrame(animated: true)
        }
    }

    /// Detect whether the (restored) frame is sitting mostly off-screen against an edge.
    private func detectTuckedState(_ panel: NSPanel) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        let f = panel.frame
        let spriteCenter = f.origin.x + spriteLeftInset + spriteWidth / 2
        if spriteCenter > vf.maxX {
            hiddenEdge = .right; isRevealed = false; uiState.isTucked = true; uiState.isRightEdge = true; uiState.isSnapped = true
        } else if spriteCenter < vf.minX {
            hiddenEdge = .left; isRevealed = false; uiState.isTucked = true; uiState.isRightEdge = false; uiState.isSnapped = true
        } else {
            uiState.isTucked = false
            if didDrag {
                hiddenEdge = nil
                uiState.isSnapped = false
            }
        }
    }

    /// Position the pet for its current `hiddenEdge` + `isRevealed` state.
    private func applyEdgeFrame(animated: Bool) {
        guard let panel, let screen = panel.screen, let edge = hiddenEdge else { return }
        let vf = screen.visibleFrame
        var f = panel.frame
        switch (edge, isRevealed) {
        case (.right, true):  f.origin.x = vf.maxX - (spriteLeftInset + spriteWidth)
        case (.right, false): f.origin.x = vf.maxX - spriteLeftInset - Self.edgePeek
        case (.left, true):   f.origin.x = vf.minX - spriteLeftInset
        case (.left, false):  f.origin.x = vf.minX + Self.edgePeek - (spriteLeftInset + spriteWidth)
        }
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                panel.animator().setFrame(f, display: true)
            } completionHandler: { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.uiState.isTucked = !self.isRevealed
                }
            }
        } else {
            panel.setFrame(f, display: true)
            uiState.isTucked = !isRevealed
        }
    }

    private func animateWindowParabola(to targetX: CGFloat, targetY: CGFloat, duration: TimeInterval) async {
        guard let panel else { return }
        let startF = panel.frame
        let startTime = Date()
        let peakHeight: CGFloat = 40.0
        
        while true {
            let elapsed = Date().timeIntervalSince(startTime)
            let t = min(1.0, elapsed / duration)
            let eased = t * (2 - t)
            
            let x = startF.origin.x + (targetX - startF.origin.x) * eased
            let arc = -4 * peakHeight * t * (t - 1)
            let y = startF.origin.y + (targetY - startF.origin.y) * eased - arc
            
            panel.setFrameOrigin(NSPoint(x: x, y: y))
            
            if t >= 1.0 { break }
            try? await Task.sleep(nanoseconds: 16_000_000)
        }
    }

    private func keepActive() {
        if uiState.sleepState == .sleeping {
            uiState.sleepState = .waking
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                if self?.uiState.sleepState == .waking {
                    self?.uiState.sleepState = nil
                }
            }
        } else if uiState.sleepState == .yawning {
            uiState.sleepState = nil
        }
        
        sleepTimer?.invalidate()
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 300.0, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.triggerSleepSequence()
            }
        }
    }

    private func triggerSleepSequence() {
        guard uiState.sleepState == nil else { return }
        uiState.sleepState = .yawning
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            if self?.uiState.sleepState == .yawning {
                self?.uiState.sleepState = .sleeping
            }
        }
    }

    /// Change the pet's size preset (from the right-click menu). Width is fixed, so the
    /// sprite stays horizontally centered; only the sprite scale + panel height change.
    /// The sprite-derived tuck geometry recomputes from `sizePreset`, so a tucked pet is
    /// re-pinned to its edge after the resize.
    func setSize(_ preset: PetSizePreset) {
        guard preset != sizePreset else { return }
        sizePreset = preset
        UserDefaults.standard.set(preset.rawValue, forKey: Self.sizeDefaultsKey)
        // Drives ClawdCompanionView's sprite scale + the DesktopPetHost frame height.
        uiState.floatingScale = preset.scale

        guard let panel else { return }
        // Width unchanged → horizontal center unchanged; grow/shrink height in place.
        let old = panel.frame
        let newSize = petSize
        panel.setFrame(NSRect(x: old.origin.x, y: old.origin.y, width: newSize.width, height: newSize.height), display: true)
        panel.saveFrame(usingName: Self.frameAutosaveName)
        updateBubbleAllowed()
        // Re-pin to the edge with the new sprite geometry (peek/inset changed with scale).
        if hiddenEdge != nil {
            applyEdgeFrame(animated: false)
        } else {
            detectTuckedState(panel)
        }
    }

    deinit {
        if let dragMonitor { NSEvent.removeMonitor(dragMonitor) }
        if let upMonitor { NSEvent.removeMonitor(upMonitor) }
    }
}

/// Borderless panels can't become key by default, which would swallow SwiftUI taps and
/// hover tracking. Allow key (so gestures work) while `.nonactivatingPanel` keeps a
/// click from ever stealing focus from the user's frontmost app.
private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The three desktop-pet sizes (parity with the Windows pet). `medium` is the original
/// default (scale 1.4 / 150pt panel) so existing users see no change. Width is shared
/// across all sizes — only the sprite scale and panel height vary.
enum PetSizePreset: String, CaseIterable {
    case small, medium, large

    /// Fixed panel width — wide enough for the longest bubble at any sprite scale.
    static let panelWidth: CGFloat = 540

    /// Sprite scale fed to ClawdCompanionView's floating layout.
    var scale: CGFloat {
        switch self {
        case .small:  return 1.0
        case .medium: return 1.4
        case .large:  return 1.85
        }
    }

    /// Panel height — must clear the scaled sprite (16 * px(4) * scale) plus the bubble
    /// slot above it, or the sprite/bubble clips against the panel edge.
    var panelHeight: CGFloat {
        switch self {
        case .small:  return 130
        case .medium: return 150
        case .large:  return 188
        }
    }

    var menuLabel: String {
        switch self {
        case .small:  return Strings.petSizeSmall
        case .medium: return Strings.petSizeMedium
        case .large:  return Strings.petSizeLarge
        }
    }

    /// Nearest preset for a given scale (used to check the active item in the menu).
    static func from(scale: CGFloat) -> PetSizePreset {
        allCases.min { abs($0.scale - scale) < abs($1.scale - scale) } ?? .medium
    }
}

/// Reactive wrapper so changing `petState.floatingScale` resizes the hosted SwiftUI
/// content (the panel itself is resized in step by `setSize`).
private struct DesktopPetHost: View {
    @ObservedObject var petState: PetWindowState
    let content: ClawdCompanionView

    var body: some View {
        content.frame(
            width: PetSizePreset.panelWidth,
            height: PetSizePreset.from(scale: petState.floatingScale).panelHeight
        )
    }
}

/// Observable flag shared with the floating ClawdCompanionView: the bubble is only
/// shown when enough of the pet is on-screen (set by DesktopPetWindowController).
@MainActor
final class PetWindowState: ObservableObject {
    static let alwaysAllowed = PetWindowState()
    @Published var bubbleAllowed = true
    @Published var isWindowVisible = true
    @Published var isTucked = false
    @Published var isHovered = false
    @Published var isRightEdge = true
    @Published var isSnapped = false
    @Published var sleepState: ClawdCompanionView.ClawdState? = nil
    /// Sprite scale for the floating pet — driven by the chosen PetSizePreset.
    @Published var floatingScale: CGFloat = 1.4
}
