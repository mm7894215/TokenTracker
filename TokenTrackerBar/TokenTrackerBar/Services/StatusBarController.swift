import AppKit
import Combine
import SwiftUI

@MainActor
final class StatusBarController: NSObject {

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let viewModel: DashboardViewModel
    private let serverManager: ServerManager
    private let launchAtLoginManager: LaunchAtLoginManager
    private var animator: MenuBarAnimator?
    private var cancellables = Set<AnyCancellable>()
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

        setupStatusItem()
        setupPopover()
        observeSyncState()
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
                self?.animator?.setState(syncing ? .syncing : .idle)
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
        let tokenLabel = NSAttributedString(string: "TOKEN", attributes: [
            .font: labelFont,
            .foregroundColor: labelColor,
        ])
        let costLabel = NSAttributedString(string: "COST", attributes: [
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
            .frame(width: 450, height: 640)

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

        // Check for Updates — dynamic text when downloading
        let updateTitle = UpdateChecker.shared.statusText ?? Strings.menuCheckForUpdates
        let updateItem = NSMenuItem(title: updateTitle, action: #selector(checkForUpdates), keyEquivalent: "u")
        updateItem.target = self
        if UpdateChecker.shared.isBusy {
            updateItem.isEnabled = false
        }
        menu.addItem(updateItem)

        menu.addItem(.separator())

        // About
        let version = UpdateChecker.shared.currentVersion()
        let aboutItem = NSMenuItem(title: "TokenTrackerBar v\(version)", action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)

        menu.addItem(.separator())

        // Show Stats in Menu Bar (toggle)
        let statsItem = NSMenuItem(title: "Show Stats in Menu Bar", action: #selector(toggleStats), keyEquivalent: "")
        statsItem.target = self
        statsItem.state = showStats ? .on : .off
        menu.addItem(statsItem)

        // Animated Icon (toggle)
        let animItem = NSMenuItem(title: "Animated Icon", action: #selector(toggleAnimation), keyEquivalent: "")
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

    @objc private func openAbout() {
        if let url = URL(string: "https://github.com/mm7894215/tokentracker") {
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
        return "\(Strings.todayTitle): \(formatted) tokens · \(cost)"
    }
}
