import AppKit
import Combine
import SwiftUI

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
    private let viewModel: DashboardViewModel
    private let serverManager: ServerManager
    private let launchAtLoginManager: LaunchAtLoginManager
    private var animator: MenuBarAnimator?
    private var cancellables = Set<AnyCancellable>()
    /// While the status-item menu is open, refreshes the “Check for Updates” row when download/check status changes.
    private var updateMenuStatusObserver: NSObjectProtocol?
    private weak var trackedStatusMenu: NSMenu?
    private static let updateMenuItemTag = 4_242

    private let menuBarHeight: CGFloat = 22
    private let menuBarIconSize = NSSize(width: 22, height: 22)
    private let emptyAttributedTitle = NSAttributedString(string: "")

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
         launchAtLoginManager: LaunchAtLoginManager) {
        self.viewModel = viewModel
        self.serverManager = serverManager
        self.launchAtLoginManager = launchAtLoginManager
        super.init()

        Self.instance = self

        setupStatusItem()
        setupPopover()
        observeSyncState()
        observeNativeBridgeSettings()
    }

    private func closePopoverForModalAlert() {
        if popover.isShown {
            popover.performClose(nil)
        }
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
            guard let self, self.showStats, self.viewModel.todayTokens > 0 else { return }
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
    }

    private func updateStatsDisplay() {
        guard let button = statusItem.button else { return }

        if showStats && viewModel.todayTokens > 0 {
            let compositeImage = makeStatsMenuBarImage(
                icon: animator?.currentImage ?? button.image,
                tokens: TokenFormatter.formatCompact(viewModel.todayTokens),
                cost: viewModel.todayCost
            )

            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            button.image = compositeImage
            statusItem.length = compositeImage.size.width
        } else {
            button.title = ""
            button.attributedTitle = emptyAttributedTitle
            button.imagePosition = .imageOnly
            statusItem.length = NSStatusItem.squareLength
            animator?.applyCurrentState()
        }
    }

    private func makeStatsMenuBarImage(icon: NSImage?, tokens: String, cost: String) -> NSImage {
        let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let labelFont = NSFont.systemFont(ofSize: 7, weight: .regular)
        let valueColor = NSColor.labelColor
        let labelColor = NSColor.labelColor

        let tokenValue = NSAttributedString(string: tokens, attributes: [
            .font: valueFont,
            .foregroundColor: valueColor,
        ])
        let costValue = NSAttributedString(string: cost, attributes: [
            .font: valueFont,
            .foregroundColor: valueColor,
        ])
        let tokenLabel = NSAttributedString(string: Strings.menuTokenLabel, attributes: [
            .font: labelFont,
            .foregroundColor: labelColor,
        ])
        let costLabel = NSAttributedString(string: Strings.menuCostLabel, attributes: [
            .font: labelFont,
            .foregroundColor: labelColor,
        ])

        let tokenColumnWidth = ceil(max(tokenValue.size().width, tokenLabel.size().width))
        let costColumnWidth = ceil(max(costValue.size().width, costLabel.size().width))
        let columnGap: CGFloat = 4
        let iconTrailingPadding: CGFloat = 6
        let trailingPadding: CGFloat = 3
        let lineGap: CGFloat = -1

        let valueHeight = ceil(max(valueFont.ascender - valueFont.descender, tokenValue.size().height))
        let labelHeight = ceil(max(labelFont.ascender - labelFont.descender, tokenLabel.size().height))
        let textBlockHeight = valueHeight + lineGap + labelHeight
        let textOriginY = floor((menuBarHeight - textBlockHeight) / 2)
        let labelOriginY = textOriginY
        let valueOriginY = labelOriginY + labelHeight + lineGap

        let iconWidth = menuBarIconSize.width
        let textOriginX = iconWidth + iconTrailingPadding
        let sepGap: CGFloat = 4  // gap on each side of separator
        let totalWidth = ceil(textOriginX + tokenColumnWidth + sepGap + 1 + sepGap + costColumnWidth + trailingPadding)
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

            let col2X = textOriginX + tokenColumnWidth + sepGap + 1 + sepGap

            let tokenRect = NSRect(x: textOriginX, y: valueOriginY, width: tokenColumnWidth, height: valueHeight)
            let costRect = NSRect(x: col2X, y: valueOriginY, width: costColumnWidth, height: valueHeight)
            let tokenLabelRect = NSRect(x: textOriginX, y: labelOriginY, width: tokenColumnWidth, height: labelHeight)
            let costLabelRect = NSRect(x: col2X, y: labelOriginY, width: costColumnWidth, height: labelHeight)

            tokenValue.draw(in: self.centeredRect(for: tokenValue, in: tokenRect))
            costValue.draw(in: self.centeredRect(for: costValue, in: costRect))
            tokenLabel.draw(in: self.centeredRect(for: tokenLabel, in: tokenLabelRect))
            costLabel.draw(in: self.centeredRect(for: costLabel, in: costLabelRect))

            // Separator line between columns
            let sepX = textOriginX + tokenColumnWidth + sepGap
            NSColor.labelColor.withAlphaComponent(0.5).setFill()
            NSRect(x: sepX, y: labelOriginY + 1, width: 0.5, height: textBlockHeight - 2).fill()

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

        popover.contentViewController = NSHostingController(rootView: rootView)
        popover.behavior = .transient
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
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)

            // Ensure popover closes when user clicks outside
            if let window = popover.contentViewController?.view.window {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKey()
            }

            // Refresh data when popover opens
            Task { await viewModel.loadAll() }
        }
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

    @objc private func quit() {
        NSApp.terminate(nil)
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
