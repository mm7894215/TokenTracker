import AppKit
import Combine
import SwiftUI

enum MenuBarDisplayMetric: String, CaseIterable {
    case todayTokens
    case todayCost
    case last7dTokens
    case totalTokens
    case totalCost
    case claude5h
    case claude7d
    case codex5h
    case codex7d
    case cursorPlan
    case cursorAuto
    case cursorAPI
    case geminiPro
    case geminiFlash
    case geminiLite
    case kimiWeekly
    case kimi5h
    case kimiTotal
    case kiroMonth
    case kiroBonus
    case copilotPremium
    case copilotChat
    case antigravityClaude
    case antigravityGPro
    case antigravityFlash

    var menuLabel: String {
        switch self {
        case .todayTokens: return "Tokens"
        case .todayCost: return "Cost"
        case .last7dTokens: return "7d"
        case .totalTokens: return "Total"
        case .totalCost: return "All $"
        case .claude5h: return "Cl 5h"
        case .claude7d: return "Cl 7d"
        case .codex5h: return "Cx 5h"
        case .codex7d: return "Cx 7d"
        case .cursorPlan: return "Cu Plan"
        case .cursorAuto: return "Cu Auto"
        case .cursorAPI: return "Cu API"
        case .geminiPro: return "Gm Pro"
        case .geminiFlash: return "Gm Flash"
        case .geminiLite: return "Gm Lite"
        case .kimiWeekly: return "Km Wk"
        case .kimi5h: return "Km 5h"
        case .kimiTotal: return "Km Tot"
        case .kiroMonth: return "Kr Mo"
        case .kiroBonus: return "Kr Bn"
        case .copilotPremium: return "Co Prem"
        case .copilotChat: return "Co Chat"
        case .antigravityClaude: return "Ag Cl"
        case .antigravityGPro: return "Ag GPro"
        case .antigravityFlash: return "Ag Fl"
        }
    }

    var settingsTitle: String {
        switch self {
        case .todayTokens: return "Today Tokens"
        case .todayCost: return "Today Cost"
        case .last7dTokens: return "Last 7 Days"
        case .totalTokens: return "Total Tokens"
        case .totalCost: return "Total Cost"
        case .claude5h: return "Claude 5h Limit"
        case .claude7d: return "Claude 7d Limit"
        case .codex5h: return "Codex 5h Limit"
        case .codex7d: return "Codex 7d Limit"
        case .cursorPlan: return "Cursor Plan Limit"
        case .cursorAuto: return "Cursor Auto Limit"
        case .cursorAPI: return "Cursor API Limit"
        case .geminiPro: return "Gemini Pro Limit"
        case .geminiFlash: return "Gemini Flash Limit"
        case .geminiLite: return "Gemini Lite Limit"
        case .kimiWeekly: return "Kimi Weekly Limit"
        case .kimi5h: return "Kimi 5h Limit"
        case .kimiTotal: return "Kimi Total Limit"
        case .kiroMonth: return "Kiro Monthly Limit"
        case .kiroBonus: return "Kiro Bonus Limit"
        case .copilotPremium: return "Copilot Premium Limit"
        case .copilotChat: return "Copilot Chat Limit"
        case .antigravityClaude: return "Antigravity Claude Limit"
        case .antigravityGPro: return "Antigravity Gemini Pro Limit"
        case .antigravityFlash: return "Antigravity Flash Limit"
        }
    }

    var settingsCategory: String {
        switch self {
        case .todayTokens, .last7dTokens, .totalTokens:
            return "tokens"
        case .todayCost, .totalCost:
            return "cost"
        case .claude5h, .claude7d, .codex5h, .codex7d,
             .cursorPlan, .cursorAuto, .cursorAPI,
             .geminiPro, .geminiFlash, .geminiLite,
             .kimiWeekly, .kimi5h, .kimiTotal,
             .kiroMonth, .kiroBonus,
             .copilotPremium, .copilotChat,
             .antigravityClaude, .antigravityGPro, .antigravityFlash:
            return "limits"
        }
    }

    /// Provider this metric is sourced from. `nil` for token/cost metrics that
    /// always have data. Used to filter the dropdown so users only see slots
    /// for providers they've configured.
    var providerKey: String? {
        switch self {
        case .todayTokens, .todayCost, .last7dTokens, .totalTokens, .totalCost:
            return nil
        case .claude5h, .claude7d: return "claude"
        case .codex5h, .codex7d: return "codex"
        case .cursorPlan, .cursorAuto, .cursorAPI: return "cursor"
        case .geminiPro, .geminiFlash, .geminiLite: return "gemini"
        case .kimiWeekly, .kimi5h, .kimiTotal: return "kimi"
        case .kiroMonth, .kiroBonus: return "kiro"
        case .copilotPremium, .copilotChat: return "copilot"
        case .antigravityClaude, .antigravityGPro, .antigravityFlash: return "antigravity"
        }
    }
}

private extension UsageLimitsResponse {
    /// Whether a provider is currently usable (configured with no error).
    /// Optional providers (kimi, copilot) treated as unavailable when nil.
    func isProviderAvailable(_ key: String) -> Bool {
        switch key {
        case "claude": return claude.configured && claude.error == nil
        case "codex": return codex.configured && codex.error == nil
        case "cursor": return cursor.configured && cursor.error == nil
        case "gemini": return gemini.configured && gemini.error == nil
        case "kimi": return (kimi?.configured == true) && (kimi?.error == nil)
        case "kiro": return kiro.configured && kiro.error == nil
        case "copilot": return (copilot?.configured == true) && (copilot?.error == nil)
        case "antigravity": return antigravity.configured && antigravity.error == nil
        default: return false
        }
    }
}

enum MenuBarDisplayPreferences {
    static let key = "MenuBarDisplayItems"
    static let defaultIDs = [MenuBarDisplayMetric.todayTokens.rawValue, MenuBarDisplayMetric.todayCost.rawValue]
    static let maxVisibleItems = 2

    /// Payload of selectable metrics for the dashboard dropdown.
    /// When `limits` is provided, limit slots whose provider is unconfigured or
    /// reporting an error are filtered out so users only see options that have
    /// data. Token/cost metrics are always included. Currently-selected ids are
    /// kept regardless so users don't lose their selection during a transient
    /// error (the rendered menu bar already hides those slots via compactMap).
    /// When `limits` is nil (loading state), all metrics are returned.
    static func availableItemsPayload(
        for limits: UsageLimitsResponse? = nil,
        keepingSelected selected: [String] = []
    ) -> [[String: String]] {
        let selectedSet = Set(selected)
        return MenuBarDisplayMetric.allCases
            .filter { metric in
                guard let provider = metric.providerKey else { return true }
                if selectedSet.contains(metric.rawValue) { return true }
                guard let limits else { return true }
                return limits.isProviderAvailable(provider)
            }
            .map {
                [
                    "id": $0.rawValue,
                    "label": $0.settingsTitle,
                    "shortLabel": $0.menuLabel,
                    "category": $0.settingsCategory,
                ]
            }
    }

    static func read(from defaults: UserDefaults = .standard) -> [String] {
        let raw = defaults.stringArray(forKey: key) ?? defaultIDs
        let normalized = normalize(raw)
        // Self-heal: if stored data drifted (legacy >2-item arrays from earlier
        // dev builds, duplicates, or unknown ids), persist the cleaned version
        // back so the next read doesn't have to keep trimming.
        if raw != normalized {
            defaults.set(normalized, forKey: key)
        }
        return normalized
    }

    static func write(_ ids: [String], to defaults: UserDefaults = .standard) {
        defaults.set(normalize(ids), forKey: key)
    }

    static func normalize(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        let allowed = Set(MenuBarDisplayMetric.allCases.map(\.rawValue))
        var normalized = ids.compactMap { raw -> String? in
            guard allowed.contains(raw), !seen.contains(raw) else { return nil }
            seen.insert(raw)
            return raw
        }
        // Pad up to `maxVisibleItems` with defaults that haven't been picked yet.
        // Guards against legacy UserDefaults written by earlier dev builds
        // (e.g. only `["todayTokens"]` would otherwise leave the second slot empty).
        for fallbackID in defaultIDs where normalized.count < maxVisibleItems {
            guard !seen.contains(fallbackID) else { continue }
            normalized.append(fallbackID)
            seen.insert(fallbackID)
        }
        return Array(normalized.prefix(maxVisibleItems))
    }
}

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

        // popover 显示期间冻结 statusItem.length：4 条数据 publisher 与 MenuBarAnimator 帧动画都会
        // 触发本方法，length 反复重设会让 status item 宽度抖动并把 popover 锚点拖着整体平移。
        // popover 关闭后由 didCloseNotification 监听器再调一次本方法把宽度对齐到最新值。
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
        MenuBarDisplayPreferences.read().compactMap { id -> MenuBarDisplayValue? in
            guard let metric = MenuBarDisplayMetric(rawValue: id) else { return nil }

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
                guard let window = viewModel.usageLimits?.codex.primaryWindow,
                      viewModel.usageLimits?.codex.configured == true,
                      viewModel.usageLimits?.codex.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatIntPercentWithReset(window.usedPercent, resetEpoch: window.resetAt))
            case .codex7d:
                guard let window = viewModel.usageLimits?.codex.secondaryWindow,
                      viewModel.usageLimits?.codex.configured == true,
                      viewModel.usageLimits?.codex.error == nil else { return nil }
                return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatIntPercentWithReset(window.usedPercent, resetEpoch: window.resetAt))
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

    private func genericLimitValue(id: String, metric: MenuBarDisplayMetric, configured: Bool?, error: String?, window: GenericLimitWindow?) -> MenuBarDisplayValue? {
        guard configured == true, error == nil, let window else { return nil }
        return MenuBarDisplayValue(id: id, label: metric.menuLabel, value: formatLimitWithReset(window.usedPercent, resetIso: window.resetAt))
    }

    private func formatLimitPercent(_ value: Double) -> String {
        "\(Int(min(max(value, 0), 100).rounded()))%"
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
        let pct = "\(usedPercent)%"
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

        popover.contentViewController = NSHostingController(rootView: rootView)
        popover.behavior = .transient

        // popover 关闭后把 statusItem.length 对齐到最新合成图宽度（显示期间被冻结）。
        NotificationCenter.default.addObserver(
            forName: NSPopover.didCloseNotification,
            object: popover,
            queue: .main
        ) { [weak self] _ in
            self?.updateStatsDisplay()
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
