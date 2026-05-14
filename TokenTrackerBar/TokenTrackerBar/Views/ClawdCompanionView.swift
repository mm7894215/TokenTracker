import SwiftUI

/// Clawd pixel-art companion with full animation suite.
/// Animations ported from Clawd-on-Desk SVG keyframes (39 states).
struct ClawdCompanionView: View {
    @ObservedObject var viewModel: DashboardViewModel

    @State private var eyesClosed = false
    @State private var hoverSide: HoverSide = .none
    @State private var currentAction: CharacterAction = .none
    @State private var quipIndex = 0
    @State private var armWave = false
    @State private var syncSpinActive = false
    @State private var syncSpinStart = Date()
    @State private var syncSpinStopTask: Task<Void, Never>?
    @State private var hoveringSync = false
    @State private var hoveringCharacter = false
    @State private var tapOverrideState: ClawdState?
    @State private var idleVariant: ClawdState = .idleLiving

    private let px: CGFloat = 4.0
    private let syncSpinPeriod: TimeInterval = 0.8

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            characterView
                .frame(width: 15 * px, height: 16 * px)
                .modifier(ActionModifier(action: currentAction))
                .modifier(ClawdHoverModifier(hoveringCharacter: $hoveringCharacter, onActive: { loc in
                    let mid = 15 * px / 2
                    hoverSide = loc.x < mid - 10 ? .left : (loc.x > mid + 10 ? .right : .center)
                }, onEnded: {
                    hoverSide = .none
                }))
                .onTapGesture { handleTap() }

            bubbleView
                .id("quip-\(quipIndex)")
                .offset(y: -2)

            Spacer(minLength: 0)

            syncButton
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom,-8)
        .onAppear {
            startBlinkLoop()
            startIdleVariantLoop()
        }
    }

    // MARK: - Speech Bubble

    @State private var hoveringBubble = false

    private var bubbleView: some View {
        Text(currentQuip)
            .font(.system(size: 12))
            .foregroundStyle(.primary.opacity(0.75))
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background {
                BubbleShape()
                    .fill(.regularMaterial)
                    .shadow(color: .black.opacity(0.08), radius: 1.5, y: 0.5)
            }
            .scaleEffect(hoveringBubble ? 1.03 : 1.0)
            .animation(.easeOut(duration: 0.12), value: hoveringBubble)
            .onHover { h in
                hoveringBubble = h
                if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .onTapGesture { handleTap() }
            .transition(.asymmetric(
                insertion: .opacity.combined(with: .scale(scale: 0.92, anchor: .leading)),
                removal: .opacity
            ))
    }

    // MARK: - Sync Button

    private var syncButton: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !syncSpinActive)) { timeline in
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 11))
                .foregroundStyle(viewModel.isSyncing ? .tertiary : (hoveringSync ? .primary : .secondary))
                .rotationEffect(.degrees(syncRotationDegrees(at: timeline.date)))
                .scaleEffect(hoveringSync && !viewModel.isSyncing ? 1.15 : 1.0)
                .animation(.easeOut(duration: 0.15), value: hoveringSync)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
                .onTapGesture { triggerManualSync() }
                .onHover { h in
                    hoveringSync = h
                    if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .accessibilityLabel(viewModel.isSyncing ? Strings.syncingUsageData : Strings.syncUsageData)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { triggerManualSync() }
                .onChange(of: viewModel.isSyncing) { syncing in
                    if syncing {
                        startSyncSpin()
                    } else {
                        stopSyncSpinAfterCurrentTurn()
                    }
                }
                .onDisappear {
                    syncSpinStopTask?.cancel()
                    syncSpinStopTask = nil
                }
        }
    }

    private func triggerManualSync() {
        guard !viewModel.isSyncing else { return }
        Task { await viewModel.triggerSync() }
    }

    private func syncRotationDegrees(at date: Date) -> Double {
        guard syncSpinActive else { return 0 }
        let elapsed = max(0, date.timeIntervalSince(syncSpinStart))
        return (elapsed / syncSpinPeriod * 360).truncatingRemainder(dividingBy: 360)
    }

    private func startSyncSpin() {
        syncSpinStopTask?.cancel()
        syncSpinStopTask = nil
        syncSpinStart = Date()
        syncSpinActive = true
    }

    private func stopSyncSpinAfterCurrentTurn() {
        guard syncSpinActive else { return }
        syncSpinStopTask?.cancel()

        let elapsed = max(0, Date().timeIntervalSince(syncSpinStart))
        let remainder = elapsed.truncatingRemainder(dividingBy: syncSpinPeriod)
        let delay = remainder == 0 ? 0 : syncSpinPeriod - remainder

        syncSpinStopTask = Task { @MainActor in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
            guard !Task.isCancelled, !viewModel.isSyncing else { return }
            syncSpinActive = false
            syncSpinStopTask = nil
        }
    }

    // MARK: - Character Canvas (all animations time-driven)

    /// Shared drawing context passed to each state's draw function.
    private struct DrawCtx {
        let t: Double
        let s: CGFloat
        let yBase: CGFloat
        let yOff: CGFloat
        let size: CGSize
        let bodyColor: Color
        let eyeColor: Color
        let eyesClosed: Bool
        let hoverLeanX: CGFloat
        let hoverEyeShift: CGFloat
        let hoveringCharacter: Bool
        let hoverSide: HoverSide

        func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat,
               dx: CGFloat = 0, dy: CGFloat = 0) -> CGRect {
            CGRect(x: (x + dx) * s, y: (y - yBase + dy) * s + yOff,
                   width: w * s, height: h * s)
        }
    }

    private var characterView: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15.0)) { timeline in
            Canvas { context, size in
                let s = px
                let yBase: CGFloat = 6
                let ctx = DrawCtx(
                    t: timeline.date.timeIntervalSinceReferenceDate,
                    s: s,
                    yBase: yBase,
                    yOff: (size.height - 10 * s) / 2,
                    size: size,
                    bodyColor: Color(red: 0.87, green: 0.53, blue: 0.43),
                    eyeColor: Color.black,
                    eyesClosed: eyesClosed,
                    hoverLeanX: hoverLeanX,
                    hoverEyeShift: hoverEyeShift,
                    hoveringCharacter: hoveringCharacter,
                    hoverSide: hoverSide
                )

                switch clawdState {
                case .idleLiving:      Self.drawIdleLiving(ctx: ctx, context: &context)
                case .idleLook:        Self.drawIdleLook(ctx: ctx, context: &context)
                case .idleDoze:        Self.drawIdleDoze(ctx: ctx, context: &context)
                case .sleeping:        Self.drawSleeping(ctx: ctx, context: &context)
                case .workingTyping:   Self.drawWorkingTyping(ctx: ctx, context: &context)
                case .workingThinking: Self.drawWorkingThinking(ctx: ctx, context: &context)
                case .workingUltrathink: Self.drawWorkingUltrathink(ctx: ctx, context: &context)
                case .disconnected:    Self.drawDisconnected(ctx: ctx, context: &context)
                case .error:           Self.drawError(ctx: ctx, context: &context)
                }
            }
        }
    }

    /// 超级思考动画用于仪表盘 WebView 加载层（与 `workingUltrathink` 一致：震颤/火花等）。
    struct LoadingMascotView: View {
        private let px: CGFloat = 4.0

        var body: some View {
            TimelineView(.animation(minimumInterval: 1.0 / 15.0)) { timeline in
                Canvas { context, size in
                    let s = px
                    let yBase: CGFloat = 6
                    let ctx = DrawCtx(
                        t: timeline.date.timeIntervalSinceReferenceDate,
                        s: s,
                        yBase: yBase,
                        yOff: (size.height - 10 * s) / 2,
                        size: size,
                        bodyColor: Color(red: 0.87, green: 0.53, blue: 0.43),
                        eyeColor: Color.black,
                        eyesClosed: false,
                        hoverLeanX: 0,
                        hoverEyeShift: 0,
                        hoveringCharacter: false,
                        hoverSide: .none
                    )
                    ClawdCompanionView.drawWorkingUltrathink(ctx: ctx, context: &context)
                }
            }
            .frame(width: 15 * px, height: 16 * px)
        }
    }

    // MARK: - Per-State Drawing Functions

    private static func drawIdleLiving(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 3.2 * .pi * 2)
        let breathDx: CGFloat = 0
        let breathDy = breathPhase * 0.5

        let actionT = (t / 10.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if actionT < 0.08 || (actionT > 0.25 && actionT < 0.30) || (actionT > 0.45 && actionT < 0.60) || actionT > 0.60 {
                return 0
            }
            if actionT >= 0.12 && actionT <= 0.22 { return 1 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1 }
            if actionT >= 0.33 && actionT <= 0.38 { return 0.5 }
            return 0
        }()

        let hoverLean = ctx.hoverLeanX
        let dx = bodyShiftX + hoverLean + breathDx
        let dy = breathDy

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3, dx: 0)), with: .color(bodyColor))
        }

        let tScaleX: CGFloat = 1.0 + breathPhase * 0.015
        let tScaleY: CGFloat = 1.0 - breathPhase * 0.015
        let tW = 11 * tScaleX, tH = 7 * tScaleY
        let tX = 2 + (11 - tW) / 2, tY = 6 + (7 - tH)
        context.fill(Path(ctx.r(tX, tY, tW, tH, dx: dx, dy: dy)), with: .color(bodyColor))

        let scratching = actionT >= 0.33 && actionT <= 0.39
        let scratchY: CGFloat = scratching ? 9 + sin(t * 30) * 1.5 : 9
        context.fill(Path(ctx.r(0, scratchY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let eyeShift: CGFloat = {
            if ctx.hoverSide != .none { return ctx.hoverEyeShift }
            if actionT >= 0.12 && actionT <= 0.22 { return 1.5 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1.5 }
            return 0
        }()

        let blinkPhases: [ClosedRange<Double>] = [0.03...0.07, 0.18...0.22, 0.47...0.51, 0.78...0.82]
        let isBlinkTime = blinkPhases.contains { $0.contains(actionT) }

        if ctx.eyesClosed || isBlinkTime {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        if ctx.hoveringCharacter {
            context.fill(Path(ctx.r(tX, tY, tW, tH, dx: dx, dy: dy)), with: .color(.white.opacity(0.06)))
        }
    }

    private static func drawIdleLook(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t

        let breathPhase = sin(t / 3.2 * .pi * 2)
        let dy = breathPhase * 0.4

        let actionT = (t / 10.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if actionT >= 0.12 && actionT <= 0.22 { return 1 }
            if actionT >= 0.48 && actionT <= 0.57 { return -1 }
            if actionT >= 0.33 && actionT <= 0.38 { return 0.5 }
            return 0
        }()
        let eyeShift: CGFloat = {
            if ctx.hoverSide != .none { return ctx.hoverEyeShift }
            if actionT >= 0.12 && actionT <= 0.22 { return 3 }
            if actionT >= 0.48 && actionT <= 0.57 { return -3 }
            return 0
        }()
        let dx = bodyShiftX + ctx.hoverLeanX

        drawBaseCharacterStatic(ctx: ctx, context: &context,
                                dx: dx, dy: dy,
                                eyeShift: eyeShift,
                                breathPhase: breathPhase)
    }

    private static func drawIdleDoze(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 4.0 * .pi * 2)
        let squashX: CGFloat = 1.05 + breathPhase * 0.03
        let dy: CGFloat = 1.0 + breathPhase * 0.8

        context.fill(Path(ctx.r(3, 15, 9 * squashX, 0.5)), with: .color(.black.opacity(0.14)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        let tW = 11 * squashX, tH = 7 * (1.0 - breathPhase * 0.03)
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6 + (7 - tH), tW, tH, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 10, 2, 2, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 10, 2, 2, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(4, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
    }

    private static func drawSleeping(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, s = ctx.s, yOff = ctx.yOff
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 4.5 * .pi * 2)
        let squashScale = 1.0 + breathPhase * 0.03
        let dy: CGFloat = 1.0 + breathPhase * 0.8

        context.fill(Path(ctx.r(3, 15, 9 * squashScale, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        let tW = 11 * squashScale, tH = 7 * (1.0 - breathPhase * 0.02)
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6 + (7 - tH), tW, tH, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 10, 2, 2, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 10, 2, 2, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(4, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))
        context.fill(Path(ctx.r(10, 9, 1, 0.35, dy: dy)), with: .color(eyeColor))

        for i in 0..<3 {
            let zT = (t + Double(i) * 2.0).truncatingRemainder(dividingBy: 6.0) / 6.0
            let rise = zT * 8
            let sway = sin(zT * .pi * 3) * 2
            let alpha: Double = {
                if zT < 0.1 { return zT * 10 }
                if zT > 0.9 { return (1.0 - zT) * 10 }
                return 0.8
            }()
            let fontSize: CGFloat = 8 + CGFloat(zT) * 4
            context.draw(
                Text("Z")
                    .font(.system(size: fontSize, weight: .bold, design: .monospaced))
                    .foregroundColor(.secondary.opacity(alpha * 0.5)),
                at: CGPoint(x: (13 + CGFloat(sway)) * s, y: (4 - rise) * s + yOff)
            )
        }
    }

    private static func drawWorkingTyping(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let jitterX: CGFloat = sin(t * 78.5) * 0.3
        let jitterY: CGFloat = sin(t * 65.3) * 0.5
        let dx = jitterX + ctx.hoverLeanX
        let dy = jitterY

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx, dy: dy)), with: .color(bodyColor))

        let leftArmY: CGFloat = 9 + sin(t * 41.9) * 1.5
        let rightArmY: CGFloat = 9 + sin(t * 52.4) * 1.5
        context.fill(Path(ctx.r(0, leftArmY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, rightArmY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let scanPhase = (t / 1.2).truncatingRemainder(dividingBy: 1.0)
        let eyeShift = CGFloat(scanPhase < 0.5 ? scanPhase * 4 - 1 : 3 - scanPhase * 4)
        if ctx.eyesClosed {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        let particleColor = Color(red: 0.25, green: 0.77, blue: 1.0)
        for i in 0..<7 {
            let pT = (t * 1.2 + Double(i) * 0.14).truncatingRemainder(dividingBy: 1.0)
            let pY = 14.0 - pT * 14.0
            let pX = 7.5 + sin(Double(i) * 2.1) * 3.5
            let alpha = pT < 0.15 ? pT / 0.15 : (pT > 0.75 ? (1.0 - pT) / 0.25 : 1.0)
            let pSize: CGFloat = 0.4 + CGFloat(pT) * 0.3
            context.fill(Path(ctx.r(CGFloat(pX), CGFloat(pY), pSize, pSize)),
                         with: .color(particleColor.opacity(alpha * 0.8)))
        }
    }

    private static func drawWorkingThinking(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let swayPhase = sin(t / 4.0 * .pi * 2)
        let swayX = swayPhase * 1.0
        let dx = swayX + ctx.hoverLeanX

        context.fill(Path(ctx.r(3 + swayX, 15, 9, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx)), with: .color(bodyColor))

        let tapPhase = sin(t / 0.8 * .pi * 2)
        let tapArmY: CGFloat = 7 + tapPhase * 0.5
        context.fill(Path(ctx.r(13, tapArmY, 2, 2, dx: dx)), with: .color(bodyColor))

        let thinkBlinkT = (t / 4.0).truncatingRemainder(dividingBy: 1.0)
        let isThinkBlink = thinkBlinkT > 0.46 && thinkBlinkT < 0.54

        if ctx.eyesClosed || isThinkBlink {
            context.fill(Path(ctx.r(4, 8.5, 1, 0.35, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 8.5, 1, 0.35, dx: dx)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4, 7, 1, 2, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 7, 1, 2, dx: dx)), with: .color(eyeColor))
        }

        let dotColor = Color(red: 0, green: 0.51, blue: 0.99)
        let bubbleX: CGFloat = -3, bubbleY: CGFloat = -1
        context.fill(Path(ctx.r(bubbleX + 1, bubbleY, 10, 7)), with: .color(.white.opacity(0.85)))
        context.fill(Path(ctx.r(bubbleX + 8, bubbleY + 7, 2, 2)), with: .color(.white.opacity(0.85)))
        context.fill(Path(ctx.r(bubbleX + 10, bubbleY + 9, 1, 1)), with: .color(.white.opacity(0.85)))

        let dotT = (t / 2.0).truncatingRemainder(dividingBy: 1.0)
        if dotT > 0.2 {
            context.fill(Path(ctx.r(bubbleX + 2.5, bubbleY + 3, 1, 1)), with: .color(dotColor))
        }
        if dotT > 0.4 {
            context.fill(Path(ctx.r(bubbleX + 5.5, bubbleY + 3, 1, 1)), with: .color(dotColor))
        }
        if dotT > 0.6 {
            context.fill(Path(ctx.r(bubbleX + 8.5, bubbleY + 3, 1, 1)), with: .color(dotColor))
        }
    }

    private static func drawWorkingUltrathink(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let shakePhase = sin(t / 0.15 * .pi)
        let dx: CGFloat = shakePhase * 0.3
        let dy: CGFloat = cos(t / 0.15 * .pi * 0.9) * 0.15

        let shadowW: CGFloat = 9 + shakePhase * 0.2
        context.fill(Path(ctx.r(3, 15, shadowW, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 13, 1, 2)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let tapFastY: CGFloat = 7 + sin(t / 0.8 * .pi * 2) * 0.5
        context.fill(Path(ctx.r(13, tapFastY, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        let focusT = (t / 2.0).truncatingRemainder(dividingBy: 1.0)
        let isFocusBlink = focusT > 0.70 && focusT < 0.78

        if ctx.eyesClosed || isFocusBlink {
            context.fill(Path(ctx.r(4, 8.5, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 8.5, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4, 7, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10, 7, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        let sparkColor = Color(red: 1, green: 0.84, blue: 0)
        for i in 0..<4 {
            let spT = (t + Double(i) * 0.3).truncatingRemainder(dividingBy: 1.2) / 1.2
            let spRise = spT * 3.0
            let spAlpha = spT < 0.15 ? spT / 0.15 : (spT > 0.6 ? max(0, (1.0 - spT) / 0.4) : 1.0)
            let spX: CGFloat = [10, 6, 3, 8][i]
            let spSize: CGFloat = 1.0 - CGFloat(spT) * 0.7
            context.fill(Path(ctx.r(spX, 6 - CGFloat(spRise), spSize, spSize, dx: dx)),
                         with: .color(sparkColor.opacity(spAlpha)))
        }

        for i in 0..<3 {
            let stT = (t + Double(i) * 0.7).truncatingRemainder(dividingBy: 2.0) / 2.0
            let stRise = stT * 2.5
            let stAlpha = stT < 0.2 ? stT * 3 : (stT > 0.7 ? max(0, (1.0 - stT) / 0.3) : 0.6)
            let stX: CGFloat = [5, 9, 7][i]
            let stSize: CGFloat = 0.8 + CGFloat(stT) * 0.7
            context.fill(Path(ctx.r(stX, 6 - CGFloat(stRise), stSize, stSize / 2, dx: dx)),
                         with: .color(.gray.opacity(stAlpha * 0.4)))
        }

        let rainbowColors: [Color] = [
            Color(red: 1, green: 0.32, blue: 0.32),
            Color(red: 1, green: 0.60, blue: 0),
            Color(red: 1, green: 0.76, blue: 0.03),
            Color(red: 0.30, green: 0.69, blue: 0.31),
            Color(red: 0.13, green: 0.59, blue: 0.95),
            Color(red: 0.61, green: 0.15, blue: 0.69),
            Color(red: 1, green: 0.32, blue: 0.32),
            Color(red: 1, green: 0.60, blue: 0),
            Color(red: 0.30, green: 0.69, blue: 0.31),
            Color(red: 0.13, green: 0.59, blue: 0.95),
        ]
        let letters = Array("ultrathink")
        let textY: CGFloat = 1.5
        let charW: CGFloat = 5.8
        let totalW = CGFloat(letters.count) * charW
        let startX = (ctx.size.width - totalW) / 2
        for (i, ch) in letters.enumerated() {
            let phase = (t + Double(i) * 0.1).truncatingRemainder(dividingBy: 1.0)
            let wave = sin(phase * .pi)
            let letterAlpha = 0.15 + wave * 0.85
            context.draw(
                Text(String(ch))
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundColor(rainbowColors[i].opacity(letterAlpha)),
                at: CGPoint(x: startX + CGFloat(i) * charW + charW / 2, y: textY)
            )
        }
    }

    private static func drawDisconnected(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, s = ctx.s, yBase = ctx.yBase, yOff = ctx.yOff
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let bodyT = (t / 6.0).truncatingRemainder(dividingBy: 1.0)
        let bodyShiftX: CGFloat = {
            if bodyT >= 0.12 && bodyT <= 0.22 { return -1 }
            if bodyT >= 0.29 && bodyT <= 0.39 { return 1 }
            if bodyT >= 0.56 && bodyT <= 0.88 { return 1 }
            return 0
        }()
        let eyeShift: CGFloat = {
            if bodyT >= 0.12 && bodyT <= 0.22 { return -2 }
            if bodyT >= 0.29 && bodyT <= 0.39 { return 2 }
            if bodyT >= 0.56 && bodyT <= 0.88 { return 3 }
            return 0
        }()

        let dx = bodyShiftX

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3)), with: .color(bodyColor))
        }

        context.fill(Path(ctx.r(2, 6, 11, 7, dx: dx)), with: .color(bodyColor))
        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx)), with: .color(bodyColor))

        let blinkT = (t / 6.0).truncatingRemainder(dividingBy: 1.0)
        let isBlinkNow = (blinkT > 0.20 && blinkT < 0.24) || (blinkT > 0.60 && blinkT < 0.64) || (blinkT > 0.80 && blinkT < 0.84)

        if ctx.eyesClosed || isBlinkNow {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx)), with: .color(eyeColor))
        }

        if bodyT < 0.50 {
            let qAlpha: Double = bodyT < 0.12 ? 0 : (bodyT < 0.46 ? 1 : (1.0 - (bodyT - 0.46) / 0.04))
            context.draw(
                Text("?")
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(.white.opacity(qAlpha)),
                at: CGPoint(x: (-2 + dx) * s, y: (2 - yBase) * s + yOff)
            )
        }
        if bodyT >= 0.50 {
            let eAlpha: Double = bodyT < 0.56 ? 0 : (bodyT < 0.85 ? 1 : (1.0 - (bodyT - 0.85) / 0.10))
            context.draw(
                Text("!")
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(Color(red: 0, green: 0.51, blue: 0.99).opacity(eAlpha)),
                at: CGPoint(x: (16 + dx) * s, y: (0 - yBase) * s + yOff)
            )
        }
    }

    private static func drawError(ctx: DrawCtx, context: inout GraphicsContext) {
        let t = ctx.t, s = ctx.s, yBase = ctx.yBase, yOff = ctx.yOff
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        let breathPhase = sin(t / 2.5 * .pi * 2)
        let squashDy: CGFloat = 1.5 + breathPhase * 0.8

        context.fill(Path(ctx.r(-1, 15, 17, 0.5)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 9, 1, 1)), with: .color(bodyColor))
        }

        let tW: CGFloat = 13 + breathPhase * 0.5
        let tX: CGFloat = 1 + (13 - tW) / 2
        context.fill(Path(ctx.r(tX, 10, tW, 5, dy: squashDy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(-1, 13, 2, 2, dy: squashDy)), with: .color(bodyColor))

        let fanPhase = sin(t / 0.4 * .pi * 2)
        let fanArmY: CGFloat = 11 + fanPhase * 1.5
        context.fill(Path(ctx.r(13, fanArmY, 2, 2, dy: squashDy)), with: .color(bodyColor))

        let xColor = eyeColor
        for eyeX: CGFloat in [3, 10] {
            context.fill(Path(ctx.r(eyeX, 12, 2, 0.4, dy: squashDy)),
                         with: .color(xColor))
            context.fill(Path(ctx.r(eyeX + 0.8, 11.2, 0.4, 2, dy: squashDy)),
                         with: .color(xColor))
        }

        for i in 0..<3 {
            let smT = (t + Double(i) * 1.0).truncatingRemainder(dividingBy: 3.0) / 3.0
            let rise = smT * 15
            let alpha = smT < 0.2 ? smT * 3 : (smT > 0.6 ? (1.0 - smT) / 0.4 : 0.6)
            let smX: CGFloat = 5 + CGFloat(i) * 2 + sin(smT * .pi) * 2
            context.fill(Path(ctx.r(smX, 6 - CGFloat(rise), 2, 1)),
                         with: .color(.gray.opacity(alpha * 0.3)))
        }

        let flashAlpha = 0.15 + sin(t / 0.8 * .pi * 2) * 0.85
        context.draw(
            Text("ERROR")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundColor(Color.red.opacity(max(0, flashAlpha))),
            at: CGPoint(x: 7.5 * s, y: (0 - yBase) * s + yOff)
        )
    }

    // MARK: - State Resolution

    enum ClawdState: Equatable {
        case idleLiving
        case idleLook
        case idleDoze
        case sleeping
        case workingTyping
        case workingThinking
        case workingUltrathink
        case disconnected
        case error
    }

    private var clawdState: ClawdState {
        // 0. Tap override (temporary animation)
        if let override = tapOverrideState { return override }

        // 1. Status overrides
        if !viewModel.serverOnline { return .disconnected }
        if viewModel.error != nil { return .error }

        // 2. Syncing → typing animation
        if viewModel.isSyncing { return .workingTyping }

        // 3. Idle — token count only affects personality (quips), not animation
        if viewModel.todayTokens == 0 { return .sleeping }
        return idleVariant
    }

    // MARK: - Drawing Helpers

    private var hoverLeanX: CGFloat {
        switch hoverSide {
        case .left: return -1.2
        case .right: return 1.2
        case .center, .none: return 0
        }
    }

    private var hoverEyeShift: CGFloat {
        switch hoverSide {
        case .left: return -0.5
        case .right: return 0.5
        case .center, .none: return 0
        }
    }

    /// Standard base character drawing with offset (used by simpler states like idleLook).
    private static func drawBaseCharacterStatic(
        ctx: DrawCtx, context: inout GraphicsContext,
        dx: CGFloat, dy: CGFloat,
        eyeShift: CGFloat, breathPhase: CGFloat
    ) {
        let bodyColor = ctx.bodyColor, eyeColor = ctx.eyeColor

        context.fill(Path(ctx.r(3, 15, 9, 0.5, dx: dx, dy: dy)), with: .color(.black.opacity(0.12)))

        for lx: CGFloat in [3, 5, 9, 11] {
            context.fill(Path(ctx.r(lx, 12, 1, 3, dx: dx, dy: dy)), with: .color(bodyColor))
        }

        let tScaleX: CGFloat = 1.0 + breathPhase * 0.015
        let tW = 11 * tScaleX, tH: CGFloat = 7
        let tX = 2 + (11 - tW) / 2
        context.fill(Path(ctx.r(tX, 6, tW, tH, dx: dx, dy: dy)), with: .color(bodyColor))

        context.fill(Path(ctx.r(0, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))
        context.fill(Path(ctx.r(13, 9, 2, 2, dx: dx, dy: dy)), with: .color(bodyColor))

        if ctx.eyesClosed {
            context.fill(Path(ctx.r(4 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 9, 1, 0.35, dx: dx, dy: dy)), with: .color(eyeColor))
        } else {
            context.fill(Path(ctx.r(4 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
            context.fill(Path(ctx.r(10 + eyeShift, 8, 1, 2, dx: dx, dy: dy)), with: .color(eyeColor))
        }

        if ctx.hoveringCharacter {
            context.fill(Path(ctx.r(tX, 6, tW, tH, dx: dx, dy: dy)), with: .color(.white.opacity(0.06)))
        }
    }

    // MARK: - Quip Pool

    private var currentQuip: String {
        let pool = quipPool
        guard !pool.isEmpty else { return "" }
        return pool[quipIndex % pool.count]
    }

    private var quipPool: [String] {
        let tokens = viewModel.todayTokens
        let cost = viewModel.todayCost
        let f = TokenFormatter.formatCompact(tokens)

        if viewModel.isSyncing {
            return Strings.syncingQuips
        }

        var pool: [String] = []

        // === Today data ===
        if tokens == 0 {
            pool += Strings.emptyTodayQuips
        } else {
            pool.append(Strings.tokensToday(f))
            if cost != "$0.00" && cost != "$0" {
                pool += [
                    Strings.tokensSpentToday(tokens: f, cost: cost),
                    Strings.aiInvestedToday(cost),
                    Strings.billToday(cost: cost, tokens: f),
                    Strings.aiTabToday(cost),
                ]
            }
            if tokens < 50_000 {
                pool += Strings.warmupQuips
            } else if tokens < 200_000 {
                pool += Strings.flowQuips
            } else if tokens < 500_000 {
                pool += Strings.busyQuips
            } else if tokens < 2_000_000 {
                pool += Strings.heavyQuips
            } else {
                pool += Strings.massiveQuips
            }
        }

        // === 7-Day / 30-Day rolling stats ===
        let w7 = viewModel.last7dTokens
        let d7 = viewModel.last7dActiveDays
        let m30 = viewModel.last30dTokens
        let avg = viewModel.last30dAvgPerDay

        if w7 > 0 {
            pool.append(Strings.sevenDayTotal(TokenFormatter.formatCompact(w7)))
            if d7 > 0 {
                pool.append("🗓️ \(Strings.activeDaysThisWeek(d7))")
                if d7 >= 7 {
                    pool.append(Strings.perfectStreak)
                }
            }
        }
        if m30 > 0 {
            pool.append(Strings.thirtyDayTotal(TokenFormatter.formatCompact(m30)))
            if avg > 0 {
                pool.append(Strings.averagingPerDay(TokenFormatter.formatCompact(avg)))
            }
        }

        // === Heatmap stats (streak, total active days) ===
        if let heatmap = viewModel.heatmap {
            let streak = heatmap.streakDays
            let totalActive = heatmap.activeDays
            if streak > 1 {
                pool.append(Strings.streakDays(streak))
            }
            if totalActive > 30 {
                pool.append(Strings.activeDaysAllTime(totalActive))
            }
        }

        // === Top model insights ===
        let models = viewModel.topModels
        if let top = models.first {
            pool.append(Strings.topModel(top.name, top.percent))
            if models.count >= 2 {
                pool.append(Strings.runnerUp(models[1].name, models[1].percent))
            }
            if models.count >= 3 {
                pool.append(Strings.modelCount(models.count))
            }
            // Source variety
            let sources = Set(models.map { $0.source })
            if sources.count >= 2 {
                let names = sources.map { $0.capitalized }.sorted().joined(separator: " + ")
                pool.append(Strings.multiToolSetup(names))
            }
        }

        // === Conversation count ===
        let convos = viewModel.todaySummary?.totals.conversationCount ?? 0
        if convos > 0 {
            pool.append(Strings.conversationsToday(convos))
            if convos >= 10 {
                pool.append(Strings.busyTalker(convos))
            }
        }

        // === Personality (always) ===
        pool += Strings.personalityQuips

        return pool
    }

    // MARK: - Tap (cycles through fun animation states)

    /// All the fun states to show temporarily on tap
    private static let tapAnimations: [ClawdState] = [
        .workingUltrathink,  // 超级思考 (震颤+火花+彩虹)
        .workingTyping,      // 打字 (抖动+数据粒子)
        .disconnected,       // 找东西 (问号/感叹号)
        .idleLook,           // 四处张望
        .idleDoze,           // 打瞌睡
        .sleeping,           // 睡觉 (Zzz)
        .error,              // 错误 (趴下+冒烟)
    ]

    @State private var tapAnimIndex = 0

    private func handleTap() {
        withAnimation(.easeInOut(duration: 0.25)) { quipIndex += 1 }

        // Physical reaction (jump/wiggle/flip via ActionModifier)
        let physicalActions: [CharacterAction] = [.jump, .wiggle, .flip, .multiBlink, .wave]
        let action = physicalActions.randomElement() ?? .jump
        currentAction = action

        switch action {
        case .wave:
            armWave = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { armWave = false }
        case .multiBlink:
            Task { @MainActor in
                for _ in 0..<3 {
                    eyesClosed = true
                    try? await Task.sleep(nanoseconds: 80_000_000)
                    eyesClosed = false
                    try? await Task.sleep(nanoseconds: 80_000_000)
                }
            }
        default: break
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if currentAction == action { currentAction = .none }
        }

        // Canvas state override: cycle through all animation states
        let anim = Self.tapAnimations[tapAnimIndex % Self.tapAnimations.count]
        tapAnimIndex += 1
        tapOverrideState = anim

        // Hold the animation for 2.5s then return to normal
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            if tapOverrideState == anim { tapOverrideState = nil }
        }
    }

    // MARK: - Idle Variant Rotation

    /// Periodically switches between idle animations for visual variety
    private func startIdleVariantLoop() {
        let delay = Double.random(in: 12...25)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            let variants: [ClawdState] = [.idleLiving, .idleLook, .idleLiving, .idleLiving, .idleLook]
            idleVariant = variants.randomElement() ?? .idleLiving
            startIdleVariantLoop()
        }
    }

    // MARK: - Idle Blink

    private func startBlinkLoop() {
        let delay = Double.random(in: 2.5...5.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard clawdState != .sleeping && clawdState != .idleDoze else {
                startBlinkLoop()
                return
            }
            eyesClosed = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                eyesClosed = false
                startBlinkLoop()
            }
        }
    }

    // MARK: - Types

    private enum HoverSide { case left, center, right, none }
    enum CharacterAction: Equatable { case none, jump, wiggle, flip, multiBlink, wave }
}

// MARK: - Action Modifier

private struct ActionModifier: ViewModifier {
    let action: ClawdCompanionView.CharacterAction
    @State private var offset: CGFloat = 0
    @State private var rotation: Double = 0
    @State private var scaleX: CGFloat = 1

    func body(content: Content) -> some View {
        content
            .offset(y: offset)
            .rotationEffect(.degrees(rotation))
            .scaleEffect(x: scaleX, y: 1)
            .onChange(of: action) { a in
                switch a {
                case .jump:
                    withAnimation(.interpolatingSpring(stiffness: 500, damping: 12)) { offset = -10 }
                    after(0.15) { withAnimation(.interpolatingSpring(stiffness: 500, damping: 12)) { offset = 0 } }
                case .wiggle:
                    withAnimation(.easeInOut(duration: 0.07).repeatCount(6, autoreverses: true)) { rotation = 6 }
                    after(0.45) { withAnimation(.easeOut(duration: 0.1)) { rotation = 0 } }
                case .flip:
                    withAnimation(.easeInOut(duration: 0.2)) { scaleX = -1 }
                    after(0.35) { withAnimation(.easeInOut(duration: 0.2)) { scaleX = 1 } }
                default: break
                }
            }
    }

    private func after(_ t: Double, _ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: block)
    }
}

// MARK: - Bubble Shape

private struct BubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 8
        let tail: CGFloat = 6
        let tailY = rect.midY
        var p = Path()
        p.addRoundedRect(in: CGRect(x: tail, y: 0, width: rect.width - tail, height: rect.height),
                         cornerSize: CGSize(width: r, height: r))
        p.move(to: CGPoint(x: tail, y: tailY - 4))
        p.addLine(to: CGPoint(x: 0, y: tailY))
        p.addLine(to: CGPoint(x: tail, y: tailY + 4))
        p.closeSubpath()
        return p
    }
}

// MARK: - Continuous Hover Modifier (macOS 14+)

private struct ClawdHoverModifier: ViewModifier {
    @Binding var hoveringCharacter: Bool
    var onActive: (CGPoint) -> Void
    var onEnded: () -> Void

    func body(content: Content) -> some View {
        if #available(macOS 14, *) {
            content.onContinuousHover { phase in
                switch phase {
                case .active(let loc):
                    if !hoveringCharacter { NSCursor.pointingHand.push() }
                    hoveringCharacter = true
                    onActive(loc)
                case .ended:
                    if hoveringCharacter { NSCursor.pop() }
                    hoveringCharacter = false
                    onEnded()
                }
            }
        } else {
            content
        }
    }
}
