import AppKit

/// Clawd-style pixel art character for the menu bar icon.
/// Uses exact coordinates from clawd-static-base.svg (15×16 grid),
/// scaled at 1.2pt per SVG unit to fill 18×18pt canvas.
///
/// Body parts drawn as filled rects, eyes cut out as transparent holes
/// so the menu bar background peeks through (works for template images).
@MainActor
final class MenuBarAnimator {

    enum State: Equatable {
        case idle
        case syncing
        case disconnected
    }

    // MARK: - Properties

    private weak var button: NSStatusBarButton?
    private var animationTimer: Timer?
    private var blinkTimer: Timer?
    private var frameIndex = 0
    private(set) var currentState: State = .idle
    private var renderedImage: NSImage
    private var overrideImage: NSImage?

    /// UserDefaults key for animation toggle
    private static let enabledKey = "MenuBarAnimationEnabled"

    /// Static fallback icon (original lightning bolt)
    private let fallbackIcon: NSImage

    // SVG → canvas transform:
    // scale 1.4pt per SVG unit, character top at SVG y=6
    // canvas: 22x22 (matches menu bar height)
    // x offset: (22 - 15*1.4)/2 = 0.5, y offset: (22 - 9*1.4)/2 = 4.7
    private let px: CGFloat = 1.54
    private let svgYBase: CGFloat = 6
    private let offsetX: CGFloat = -0.1
    private let offsetY: CGFloat = 4.07
    private let canvasSize = NSSize(width: 22, height: 22)

    // Pre-rendered frames
    /// The current icon image (for external use, e.g. stats rendering)
    var currentImage: NSImage { renderedImage }
    var onImageUpdated: ((NSImage) -> Void)?

    private lazy var idleFrame = buildFrame(eyesClosed: false, yShift: 0)
    private lazy var blinkFrame = buildFrame(eyesClosed: true, yShift: 0)
    private lazy var syncFrames = buildSyncFrames()
    private lazy var disconnectedFrame = buildDisconnectedFrame()

    /// Whether pixel animation is enabled (persisted in UserDefaults)
    var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            applyCurrentState()
        }
    }

    // MARK: - Init

    init(button: NSStatusBarButton) {
        self.button = button
        let icon = NSImage(named: "MenuBarIcon") ?? NSImage()
        icon.isTemplate = true
        self.fallbackIcon = icon
        self.renderedImage = icon
        applyCurrentState()
    }

    // MARK: - Public

    func setState(_ newState: State) {
        guard newState != currentState else { return }
        currentState = newState
        applyCurrentState()
    }

    /// Replaces the animated Clawd frames with a provider icon. Passing nil
    /// restores the user's existing animation preference and current state.
    func setOverrideImage(_ image: NSImage?) {
        overrideImage = image
        applyCurrentState()
    }

    func applyCurrentState() {
        frameIndex = 0
        stopAnimation()
        cancelBlink()

        if let overrideImage {
            setButtonImage(overrideImage)
            return
        }

        guard isEnabled else {
            setButtonImage(fallbackIcon)
            return
        }

        if reduceMotion {
            setButtonImage(idleFrame)
            return
        }

        switch currentState {
        case .idle:
            setButtonImage(idleFrame)
            scheduleNextBlink()
        case .syncing:
            startAnimation(interval: 0.15)
        case .disconnected:
            setButtonImage(disconnectedFrame)
        }
    }

    // MARK: - Animation Loop

    private func startAnimation(interval: TimeInterval) {
        tick()
        animationTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
    }

    private func tick() {
        guard currentState == .syncing, !syncFrames.isEmpty else { return }
        setButtonImage(syncFrames[frameIndex % syncFrames.count])
        frameIndex += 1
    }

    // MARK: - Idle Blink

    private func scheduleNextBlink() {
        cancelBlink()
        let delay = TimeInterval.random(in: 3...6)
        blinkTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.playBlink() }
        }
    }

    private func cancelBlink() {
        blinkTimer?.invalidate()
        blinkTimer = nil
    }

    private func playBlink() {
        guard overrideImage == nil else { return }
        guard currentState == .idle, !reduceMotion, isEnabled else {
            if currentState == .idle { scheduleNextBlink() }
            return
        }
        setButtonImage(blinkFrame)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, self.currentState == .idle else { return }
            self.setButtonImage(self.idleFrame)
            self.scheduleNextBlink()
        }
    }

    // MARK: - Sync Frames

    /// Bounce animation: character hops up 1pt every other frame, with a blink mid-cycle.
    private func buildSyncFrames() -> [NSImage] {
        [
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
            buildFrame(eyesClosed: true,  yShift: 0),
            buildFrame(eyesClosed: true,  yShift: -1),
            buildFrame(eyesClosed: false, yShift: 0),
            buildFrame(eyesClosed: false, yShift: -1),
        ]
    }

    // MARK: - Disconnected Frame (dimmed character with ?)

    private func buildDisconnectedFrame() -> NSImage {
        let img = NSImage(size: canvasSize, flipped: true) { [self] _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }

            NSColor.black.withAlphaComponent(0.5).setFill()

            svgRect(2, 6, 11, 7).fill()     // torso
            svgRect(0, 9, 2, 2).fill()      // left arm
            svgRect(13, 9, 2, 2).fill()     // right arm
            svgRect(3, 13, 1, 2).fill()
            svgRect(5, 13, 1, 2).fill()
            svgRect(9, 13, 1, 2).fill()
            svgRect(11, 13, 1, 2).fill()

            // "?" mark above head
            let font = NSFont.systemFont(ofSize: 7, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.black.withAlphaComponent(0.7),
            ]
            let str = NSAttributedString(string: "?", attributes: attrs)
            let strSize = str.size()
            let qx = (canvasSize.width - strSize.width) / 2
            str.draw(at: NSPoint(x: qx, y: 0))

            return true
        }
        img.isTemplate = true
        return img
    }

    // MARK: - Frame Drawing (exact SVG geometry)

    /// Convert SVG coordinates to canvas rect
    private func svgRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
        NSRect(
            x: x * px + offsetX,
            y: (y - svgYBase) * px + offsetY,
            width: w * px,
            height: h * px
        )
    }

    private func buildFrame(eyesClosed: Bool, yShift: CGFloat) -> NSImage {
        let img = NSImage(size: canvasSize, flipped: true) { [self] _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }

            // Vertical shift for bounce animation
            if yShift != 0 { ctx.translateBy(x: 0, y: yShift) }

            // --- Draw body (all parts from clawd-static-base.svg) ---
            NSColor.black.setFill()

            svgRect(2, 6, 11, 7).fill()     // torso
            svgRect(0, 9, 2, 2).fill()      // left arm
            svgRect(13, 9, 2, 2).fill()     // right arm
            svgRect(3, 13, 1, 2).fill()     // outer-left-leg
            svgRect(5, 13, 1, 2).fill()     // inner-left-leg
            svgRect(9, 13, 1, 2).fill()     // inner-right-leg
            svgRect(11, 13, 1, 2).fill()    // outer-right-leg

            // --- Cut out eyes (transparent holes) unless blinking ---
            if !eyesClosed {
                ctx.setBlendMode(.clear)
                NSColor.clear.setFill()
                svgRect(4, 8, 1, 2).fill()  // left eye
                svgRect(10, 8, 1, 2).fill() // right eye
            }

            return true
        }
        img.isTemplate = true
        return img
    }

    // MARK: - Helpers

    private func setButtonImage(_ image: NSImage) {
        let displayedImage = overrideImage ?? image
        renderedImage = displayedImage
        button?.image = displayedImage
        onImageUpdated?(displayedImage)
    }

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}
