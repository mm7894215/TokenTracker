import AppKit
import Combine
import SwiftUI

private struct MenuBarDisplayValue {
    let id: String
    let label: String
    let value: String
}

@MainActor
final class StatusBarController: NSObject {

    private static weak var instance: StatusBarController?

    /// 在显示 `NSAlert` / sheet 前调用：收起菜单栏 Popover，否则其 `NSPanel` 常会盖住更新提示。
    static func prepareForSystemAlert() {
        instance?.closePopoverForModalAlert()
    }

    /// Popover height adapts to content: shorter on macOS < 13 where the Charts module is unavailable.
    private static let popoverHeight: CGFloat = {
        if #available(macOS 13, *) { return 720 }
        return 560
    }()

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private var popoverAnchorWindow: NSWindow?
    private let viewModel: DashboardViewModel
    private let serverManager: ServerManager
    private let launchAtLoginManager: LaunchAtLoginManager
    private let desktopPetController: DesktopPetWindowController
    private var animator: MenuBarAnimator?
    private let confettiController = ScreenConfettiOverlayController()
    private var cancellables = Set<AnyCancellable>()
    /// While the status-item menu is open, refreshes the “Check for Updates” row when download/check status changes.
    private var updateMenuStatusObserver: NSObjectProtocol?
    private weak var trackedStatusMenu: NSMenu?
    private static let updateMenuItemTag = 4_242

    private let menuBarHeight: CGFloat = 22
    private let menuBarIconSize = NSSize(width: 22, height: 22)
    private let emptyAttributedTitle = NSAttributedString(string: "")
    private var isUpdatingDisplay = false

    private static let showStatsKey = "MenuBarShowStats"
    private var showStats: Bool {
        get { UserDefaults.standard.object(forKey: Self.showStatsKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.showStatsKey)
            updateStatsDisplay()
        }
    }

    // MARK: - Init

    init(viewModel: DashboardViewModel,
         serverManager: ServerManager,
         launchAtLoginManager: LaunchAtLoginManager,
         desktopPetController: DesktopPetWindowController) {
        self.viewModel = viewModel
        self.serverManager = serverManager
        self.launchAtLoginManager = launchAtLoginManager
        self.desktopPetController = desktopPetController
        super.init()

        Self.instance = self

        setupStatusItem()
        setupPopover()
        observeSyncState()
        observeNativeBridgeSettings()
        observeApplicationActivity()
        observeWeeklyLimitReset()
    }

    // MARK: - Limit-reset celebration

    /// Listen for the ViewModel's reset detection and fire the firework — but
    /// only when the user has opted in.
    private func observeWeeklyLimitReset() {
        NotificationCenter.default.addObserver(
            forName: .weeklyLimitReset,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let event = note.object as? LimitResetEvent
            MainActor.assumeIsolated { self?.celebrateLimitReset(event: event) }
        }
    }

    private func celebrateLimitReset(event: LimitResetEvent?) {
        guard WeeklyLimitResetDetector.confettiEnabled() else { return }
        let name = event.map { LimitsSettingsStore.displayNames[$0.provider] ?? $0.provider.capitalized }
        confettiController.play(message: Strings.limitResetCelebration(provider: name))
    }

    private func closePopoverForModalAlert() {
        closePopoverIfShown()
    }

    private func closePopoverIfShown() {
        if popover.isShown {
            popover.performClose(nil)
        }
        popoverAnchorWindow?.orderOut(nil)
    }

    /// React to setting changes pushed by the dashboard SettingsPage via NativeBridge.
    /// Re-reads UserDefaults and refreshes the menu-bar visuals (stats badge + animation state).
    private func observeNativeBridgeSettings() {
        NotificationCenter.default.addObserver(
            forName: .nativeSettingsChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.animator?.applyCurrentState()
                self.updateStatsDisplay()
            }
        }
    }

    private func observeApplicationActivity() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            self?.closePopoverIfShown()
        }
    }

    // MARK: - Status Item

    private func setupStatusItem() {
        guard let button = statusItem.button else { return }

        let image = NSImage(named: "MenuBarIcon")
        image?.isTemplate = true
        button.image = image

        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.action = #selector(handleClick(_:))
        button.target = self

        animator = MenuBarAnimator(button: button)
        animator?.onImageUpdated = { [weak self] _ in
            guard let self, self.showStats, !self.buildMenuBarDisplayValues().isEmpty else { return }
            self.updateStatsDisplay()
        }
        updateStatsDisplay()
    }

    private func observeSyncState() {
        viewModel.$isSyncing
            .receive(on: RunLoop.main)
            .sink { [weak self] syncing in
                guard let self else { return }
                if syncing {
                    self.animator?.setState(.syncing)
                } else if !self.viewModel.serverOnline {
                    self.animator?.setState(.disconnected)
                } else {
                    self.animator?.setState(.idle)
                }
            }
            .store(in: &cancellables)

        // Observe server online status for disconnected icon
        viewModel.$serverOnline
            .receive(on: RunLoop.main)
            .sink { [weak self] online in
                guard let self, !self.viewModel.isSyncing else { return }
                self.animator?.setState(online ? .idle : .disconnected)
            }
            .store(in: &cancellables)

        // Update stats text when today data changes
        viewModel.$todaySummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)

        viewModel.$rollingSummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)

        viewModel.$totalSummary
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)

        viewModel.$usageLimits
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatsDisplay() }
            .store(in: &cancellables)
    }

    private func updateStatsDisplay() {
        guard !isUpdatingDisplay else { return }
        isUpdatingDisplay = true
        defer { isUpdatingDisplay = false }
        guard let button = statusItem.button else { return }
        let displayItems = buildMenuBarDisplayValues()

        // Freeze statusItem.length while the popover is shown: stats publishers and
        // animator frames both call this method, and a flicker in length drags the
        // popover anchor sideways. The didCloseNotification observer realigns width
        // after the popover closes.
        let canResizeStatusItem = !popover.isShown

        if showStats && !displayItems.isEmpty {
            let compositeImage = makeDisplayMenuBarImage(
                icon: animator?.currentImage ?? button.image,
                items: displayItems
            )

            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            button.image = compositeImage
            if canResizeStatusItem {
                statusItem.length = compositeImage.size.width
            }
        } else {
            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            if canResizeStatusItem {
                statusItem.length = NSStatusItem.squareLength
            }
            animator?.applyCurrentState()
        }
    }

    private func buildMenuBarDisplayValues() -> [MenuBarDisplayValue] {
        // Filter here as well as in `availableItemIDs`: a dashboard-applied
        // snapshot re-renders via `.nativeSettingsChanged` before the stored
        // selection is re-normalized, so the stored ids can still contain a
        // freshly hidden provider at this point.
        let hiddenProviders = LimitsSettingsStore.shared.hiddenProviders
        return MenuBarDisplayPreferences.read().compactMap { id -> MenuBarDisplayValue? in
            guard let metric = MenuBarDisplayMetric(rawValue: id) else { return nil }
            if let provider = metric.providerKey, hiddenProviders.contains(provider) { return nil }

            switch metric {
            case .todayTokens:
                guard viewModel.todaySummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.todayTokens)
                )
            case .todayCost:
                guard viewModel.todaySummary != nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: viewModel.todayCost)
            case .last7dTokens:
                guard viewModel.rollingSummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.last7dTokens)
                )
            case .totalTokens:
                guard viewModel.totalSummary != nil else { return nil }
                return MenuBarDisplayValue(
                    id: id,
                    label: metric.menuLabel,
                    value: TokenFormatter.formatCompact(viewModel.totalTokens)
                )
            case .totalCost:
                guard viewModel.totalSummary != nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: viewModel.totalCost)
            case .claude5h:
                guard let window = viewModel.usageLimits?.claude.fiveHour,
                      viewModel.usageLimits?.claude.configured == true,
                      viewModel.usageLimits?.claude.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatLimitWithReset(window.utilization, resetIso: window.resetsAt))
            case .claude7d:
                guard let window = viewModel.usageLimits?.claude.sevenDay,
                      viewModel.usageLimits?.claude.configured == true,
                      viewModel.usageLimits?.claude.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatLimitWithReset(window.utilization, resetIso: window.resetsAt))
            case .codex5h:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.primaryWindow)
            case .codex7d:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.secondaryWindow)
            case .codexSpark5h:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.sparkPrimaryWindow)
            case .codexSpark7d:
                return codexLimitValue(id: id, metric: metric, window: viewModel.usageLimits?.codex.sparkSecondaryWindow)
            case .cursorPlan:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.primaryWindow)
            case .cursorAuto:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.secondaryWindow)
            case .cursorAPI:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.cursor.configured, error: viewModel.usageLimits?.cursor.error, window: viewModel.usageLimits?.cursor.tertiaryWindow)
            case .geminiPro:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.primaryWindow)
            case .geminiFlash:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.secondaryWindow)
            case .geminiLite:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.gemini.configured, error: viewModel.usageLimits?.gemini.error, window: viewModel.usageLimits?.gemini.tertiaryWindow)
            case .kimiWeekly:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.primaryWindow)
            case .kimi5h:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.secondaryWindow)
            case .kimiTotal:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kimi?.configured, error: viewModel.usageLimits?.kimi?.error, window: viewModel.usageLimits?.kimi?.tertiaryWindow)
            case .kiroMonth:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kiro.configured, error: viewModel.usageLimits?.kiro.error, window: viewModel.usageLimits?.kiro.primaryWindow)
            case .kiroBonus:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.kiro.configured, error: viewModel.usageLimits?.kiro.error, window: viewModel.usageLimits?.kiro.secondaryWindow)
            case .grokMonth:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.grok?.configured, error: viewModel.usageLimits?.grok?.error, window: viewModel.usageLimits?.grok?.primaryWindow)
            case .grokOndemand:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.grok?.configured, error: viewModel.usageLimits?.grok?.error, window: viewModel.usageLimits?.grok?.secondaryWindow)
            case .copilotPremium:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.copilot?.configured, error: viewModel.usageLimits?.copilot?.error, window: viewModel.usageLimits?.copilot?.primaryWindow)
            case .copilotChat:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.copilot?.configured, error: viewModel.usageLimits?.copilot?.error, window: viewModel.usageLimits?.copilot?.secondaryWindow)
            case .antigravityClaude:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.primaryWindow)
            case .antigravityGPro:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.secondaryWindow)
            case .antigravityFlash:
                return genericLimitValue(id: id, metric: metric, configured: viewModel.usageLimits?.antigravity.configured, error: viewModel.usageLimits?.antigravity.error, window: viewModel.usageLimits?.antigravity.tertiaryWindow)
            }
        }
    }

    private func codexLimitValue(id: String, metric: MenuBarDisplayMetric, window: CodexWindow?) -> MenuBarDisplayValue? {
        let value = window.map { formatIntPercentWithReset($0.usedPercent, resetEpoch: $0.resetAt) }
        return genericLimitValue(
            id: id,
            metric: metric,
            configured: viewModel.usageLimits?.codex.configured,
            error: viewModel.usageLimits?.codex.error,
            value: value
        )
    }

    private func genericLimitValue(id: String, metric: MenuBarDisplayMetric, configured: Bool?, error: String?, window: GenericLimitWindow?) -> MenuBarDisplayValue? {
        let value = window.map { formatLimitWithReset($0.usedPercent, resetIso: $0.resetAt) }
        return genericLimitValue(id: id, metric: metric, configured: configured, error: error, value: value)
    }

    private func genericLimitValue(id: String, metric: MenuBarDisplayMetric, configured: Bool?, error: String?, value: String?) -> MenuBarDisplayValue? {
        guard configured == true, error == nil, let value else { return nil }
        return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: value)
    }

    private func formatLimitPercent(_ value: Double) -> String {
        let raw = min(max(value, 0), 100)
        let displayed = LimitsSettingsStore.shared.displayMode == .remaining ? (100 - raw) : raw
        return "\(Int(displayed.rounded()))%"
    }

    private func formatResetTime(iso: String?) -> String? {
        guard let iso else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: iso)
        }()
        guard let date else { return nil }
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return "now" }
        let d = Int(s) / 86400
        if d > 0 { return "\(d)d" }
        let h = Int(s) / 3600
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func formatLimitWithReset(_ utilization: Double, resetIso: String?) -> String {
        let pct = formatLimitPercent(utilization)
        guard let reset = formatResetTime(iso: resetIso) else { return pct }
        return "\(pct) · \(reset)"
    }

    private func formatResetTime(epoch: Int?) -> String? {
        guard let epoch else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(epoch))
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return "now" }
        let d = Int(s) / 86400
        if d > 0 { return "\(d)d" }
        let h = Int(s) / 3600
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func formatIntPercentWithReset(_ usedPercent: Int, resetEpoch: Int?) -> String {
        let clamped = min(max(usedPercent, 0), 100)
        let displayed = LimitsSettingsStore.shared.displayMode == .remaining ? (100 - clamped) : clamped
        let pct = "\(displayed)%"
        guard let reset = formatResetTime(epoch: resetEpoch) else { return pct }
        return "\(pct) · \(reset)"
    }

    private func makeDisplayMenuBarImage(icon: NSImage?, items: [MenuBarDisplayValue]) -> NSImage {
        let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let labelFont = NSFont.systemFont(ofSize: 7, weight: .regular)
        let valueColor = NSColor.labelColor
        let labelColor = NSColor.labelColor

        let columns = items.map { item in
            let value = NSAttributedString(string: item.value, attributes: [
                .font: valueFont,
                .foregroundColor: valueColor,
            ])
            let label = NSAttributedString(string: item.label, attributes: [
                .font: labelFont,
                .foregroundColor: labelColor,
            ])
            let width = ceil(max(value.size().width, label.size().width))
            return (value: value, label: label, width: width)
        }

        let iconTrailingPadding: CGFloat = 6
        let trailingPadding: CGFloat = 3
        let lineGap: CGFloat = -1
        let sepGap: CGFloat = 4

        let valueHeight = ceil(max(valueFont.ascender - valueFont.descender, columns.map { $0.value.size().height }.max() ?? 0))
        let labelHeight = ceil(max(labelFont.ascender - labelFont.descender, columns.map { $0.label.size().height }.max() ?? 0))
        let textBlockHeight = valueHeight + lineGap + labelHeight
        let textOriginY = floor((menuBarHeight - textBlockHeight) / 2)
        let labelOriginY = textOriginY
        let valueOriginY = labelOriginY + labelHeight + lineGap

        let iconWidth = menuBarIconSize.width
        let textOriginX = iconWidth + iconTrailingPadding
        let columnsWidth = columns.enumerated().reduce(CGFloat(0)) { total, pair in
            let separatorWidth: CGFloat = pair.offset == 0 ? 0 : (sepGap + 1 + sepGap)
            return total + separatorWidth + pair.element.width
        }
        let totalWidth = ceil(textOriginX + columnsWidth + trailingPadding)
        let imageSize = NSSize(width: totalWidth, height: menuBarHeight)

        let image = NSImage(size: imageSize, flipped: false) { [weak self] _ in
            guard let self else { return false }

            if let icon {
                let iconRect = NSRect(origin: .zero, size: self.menuBarIconSize)
                // Template icons are black alpha — tint to labelColor for compositing
                if icon.isTemplate {
                    icon.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1)
                    NSColor.labelColor.setFill()
                    iconRect.fill(using: .sourceAtop)
                } else {
                    icon.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1)
                }
            }

            var cursorX = textOriginX
            for (index, column) in columns.enumerated() {
                if index > 0 {
                    let sepX = cursorX + sepGap
                    NSColor.labelColor.withAlphaComponent(0.5).setFill()
                    NSRect(x: sepX, y: labelOriginY + 1, width: 0.5, height: textBlockHeight - 2).fill()
                    cursorX = sepX + 1 + sepGap
                }

                let valueRect = NSRect(x: cursorX, y: valueOriginY, width: column.width, height: valueHeight)
                let labelRect = NSRect(x: cursorX, y: labelOriginY, width: column.width, height: labelHeight)
                column.value.draw(in: self.centeredRect(for: column.value, in: valueRect))
                column.label.draw(in: self.centeredRect(for: column.label, in: labelRect))
                cursorX += column.width
            }

            return true
        }

        image.isTemplate = false
        return image
    }

    private func centeredRect(for string: NSAttributedString, in rect: NSRect) -> NSRect {
        let size = string.size()
        return NSRect(
            x: rect.minX + floor((rect.width - size.width) / 2),
            y: rect.minY + floor((rect.height - size.height) / 2),
            width: ceil(size.width),
            height: ceil(size.height)
        )
    }

    // MARK: - Popover

    private func setupPopover() {
        let rootView = DashboardView(viewModel: viewModel, serverManager: serverManager)
            .frame(width: 480, height: Self.popoverHeight)

        // macOS 26+: keep the SwiftUI content transparent (see `PopoverSurfaceBackground`) so the
        // system `NSPopover` chrome's automatic Liquid Glass (`NSGlassEffectView`, verified in the
        // popover's view tree) shows through. Do NOT mount a glass/material backdrop in the content
        // layer — HIG reserves Liquid Glass for the control/navigation layer, and a content-layer
        // fill here only covers the real glass. Older systems keep classic `.regularMaterial`.
        popover.contentViewController = NSHostingController(rootView: rootView)
        popover.behavior = .transient

        // popover 关闭后把 statusItem.length 对齐到最新合成图宽度（显示期间被冻结）。
        NotificationCenter.default.addObserver(
            forName: NSPopover.didCloseNotification,
            object: popover,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.popoverAnchorWindow?.orderOut(nil)
                self?.updateStatsDisplay()
            }
        }
    }

    // MARK: - Click Handling

    @objc private func handleClick(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }

        if event.type == .rightMouseUp {
            showMenu()
        } else {
            togglePopover()
        }
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            guard let anchorView = positionPopoverAnchorWindow(under: button) else { return }
            popover.show(relativeTo: anchorView.bounds, of: anchorView, preferredEdge: .minY)

            // Keep keyboard focus inside the popover while it is visible.
            if let window = popover.contentViewController?.view.window {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKey()
            }

            // Refresh data when popover opens
            Task { await viewModel.loadAll() }
        }
    }

    private func makePopoverAnchorWindow() -> NSWindow {
        let anchorSize = NSSize(width: 2, height: 1)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: anchorSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = NSView(frame: NSRect(origin: .zero, size: anchorSize))
        window.backgroundColor = .clear
        window.alphaValue = 0
        window.isOpaque = false
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        window.isReleasedWhenClosed = false
        return window
    }

    private func positionPopoverAnchorWindow(under button: NSStatusBarButton) -> NSView? {
        guard let buttonWindow = button.window else { return nil }
        let buttonRectInWindow = button.convert(button.bounds, to: nil)
        let buttonRectOnScreen = buttonWindow.convertToScreen(buttonRectInWindow)
        let anchorSize = NSSize(width: 2, height: 1)
        let anchorFrame = NSRect(
            x: buttonRectOnScreen.midX - anchorSize.width / 2,
            y: buttonRectOnScreen.minY,
            width: anchorSize.width,
            height: anchorSize.height
        )
        let window = popoverAnchorWindow ?? makePopoverAnchorWindow()
        popoverAnchorWindow = window
        window.setFrame(anchorFrame, display: false)
        window.orderFrontRegardless()
        return window.contentView
    }

    // MARK: - Right-Click Menu

    private func showMenu() {
        let menu = NSMenu()

        // Today summary — click to open popover
        let todayText = buildTodaySummary()
        let todayItem = NSMenuItem(title: "", action: #selector(openPopover), keyEquivalent: "")
        todayItem.target = self
        todayItem.attributedTitle = NSAttributedString(
            string: todayText,
            attributes: [
                .font: NSFont.menuFont(ofSize: 13),
                .foregroundColor: NSColor.labelColor
            ]
        )
        menu.addItem(todayItem)

        menu.addItem(.separator())

        // Sync Now
        let syncItem = NSMenuItem(title: Strings.menuSyncNow, action: #selector(syncNow), keyEquivalent: "r")
        syncItem.target = self
        syncItem.isEnabled = !viewModel.isSyncing
        menu.addItem(syncItem)

        // Open Dashboard
        let dashboardItem = NSMenuItem(title: Strings.openDashboard, action: #selector(openDashboard), keyEquivalent: "d")
        dashboardItem.target = self
        menu.addItem(dashboardItem)

        // Settings — jumps straight to the dashboard Settings page.
        // NOTE: selector must NOT be named `openSettings(_:)` — AppKit treats that as
        // the system Settings action and injects a gear image + steals the item. Use
        // a custom name so the item renders plain.
        let settingsItem = NSMenuItem(title: Strings.menuSettings, action: #selector(openDashboardSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        // Check for Updates — dynamic text when downloading (refreshes via Notification while menu stays open)
        let updateTitle = UpdateChecker.shared.statusText ?? Strings.menuCheckForUpdates
        let updateItem = NSMenuItem(title: updateTitle, action: #selector(checkForUpdates), keyEquivalent: "u")
        updateItem.tag = Self.updateMenuItemTag
        updateItem.target = self
        updateItem.isEnabled = !UpdateChecker.shared.isBusy
        menu.addItem(updateItem)

        menu.delegate = self

        menu.addItem(.separator())

        // About
        let version = UpdateChecker.shared.currentVersion()
        let aboutItem = NSMenuItem(title: "TokenTrackerBar v\(version)", action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)

        // Star on GitHub — only visible to users who actively open the menu,
        // so it's not a "promotional" intrusion. Sits next to About by
        // convention (users scan that region for project links).
        let starItem = NSMenuItem(title: Strings.menuStarOnGitHub, action: #selector(openGitHub), keyEquivalent: "")
        starItem.target = self
        menu.addItem(starItem)

        menu.addItem(.separator())

        // Show Stats in Menu Bar (toggle)
        let statsItem = NSMenuItem(title: Strings.menuShowStats, action: #selector(toggleStats), keyEquivalent: "")
        statsItem.target = self
        statsItem.state = showStats ? .on : .off
        menu.addItem(statsItem)

        // Animated Icon (toggle)
        let animItem = NSMenuItem(title: Strings.menuAnimatedIcon, action: #selector(toggleAnimation), keyEquivalent: "")
        animItem.target = self
        animItem.state = (animator?.isEnabled ?? true) ? .on : .off
        menu.addItem(animItem)

        // Launch at Login (toggle)
        let loginItem = NSMenuItem(title: Strings.menuLaunchAtLogin, action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = launchAtLoginManager.isEnabled ? .on : .off
        menu.addItem(loginItem)

        let petItem = NSMenuItem(title: Strings.menuDesktopPet, action: #selector(toggleDesktopPet), keyEquivalent: "")
        petItem.target = self
        petItem.state = desktopPetController.isVisible ? .on : .off
        menu.addItem(petItem)

        menu.addItem(.separator())

        // Quit
        let quitItem = NSMenuItem(title: Strings.quitButton, action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        // Show the menu at the status item
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        // Clear menu so left-click works again next time
        statusItem.menu = nil
    }

    // MARK: - Menu Actions

    @objc private func openPopover() {
        // Small delay to let the menu dismiss before showing popover
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.togglePopover()
        }
    }

    @objc private func syncNow() {
        Task { await viewModel.triggerSync() }
    }

    @objc private func openDashboard() {
        DashboardWindowController.shared.showWindow()
    }

    @objc private func openDashboardSettings() {
        DashboardWindowController.shared.showSettings()
    }

    @objc private func checkForUpdates() {
        UpdateChecker.shared.check(silent: false)
    }

    @objc private func openGitHub() {
        if let url = URL(string: "https://github.com/mm7894215/TokenTracker") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openAbout() {
        if let url = URL(string: "https://github.com/mm7894215/TokenTracker") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func toggleStats() {
        showStats.toggle()
    }

    @objc private func toggleAnimation() {
        animator?.isEnabled.toggle()
    }

    @objc private func toggleLaunchAtLogin() {
        launchAtLoginManager.toggle()
    }

    @objc private func toggleDesktopPet() {
        desktopPetController.toggle()
    }

    @objc private func quit() {
        AppDelegate.requestQuit()
    }

    // MARK: - Helpers

    private func buildTodaySummary() -> String {
        let tokens = viewModel.todayTokens
        let cost = viewModel.todayCost

        if tokens == 0 {
            return "\(Strings.todayTitle): \(Strings.noData)"
        }

        let formatted = TokenFormatter.formatCompact(tokens)
        return "\(Strings.todayTitle): \(formatted) \(Strings.tokensUnit) · \(cost)"
    }

    private func applyUpdateMenuItemState(in menu: NSMenu) {
        guard let item = menu.item(withTag: Self.updateMenuItemTag) else { return }
        let title = UpdateChecker.shared.statusText ?? Strings.menuCheckForUpdates
        if item.title != title {
            item.title = title
        }
        let enabled = !UpdateChecker.shared.isBusy
        if item.isEnabled != enabled {
            item.isEnabled = enabled
        }
    }
}

// MARK: - NSMenuDelegate (live update row while menu is open)

@MainActor
extension StatusBarController: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        trackedStatusMenu = menu
        updateMenuStatusObserver = NotificationCenter.default.addObserver(
            forName: .updateCheckerStatusDidChange,
            object: UpdateChecker.shared,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, let menu = self.trackedStatusMenu else { return }
                self.applyUpdateMenuItemState(in: menu)
            }
        }
        applyUpdateMenuItemState(in: menu)
    }

    func menuDidClose(_ menu: NSMenu) {
        trackedStatusMenu = nil
        if let observer = updateMenuStatusObserver {
            NotificationCenter.default.removeObserver(observer)
            updateMenuStatusObserver = nil
        }
    }
}
