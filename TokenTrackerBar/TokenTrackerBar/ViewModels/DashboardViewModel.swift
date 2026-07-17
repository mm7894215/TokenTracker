import SwiftUI
import Combine
import os

// MARK: - Supporting Types

struct FleetEntry: Identifiable {
    let id = UUID()
    let label: String
    let totalPercent: String
    let usd: Double
    let usage: Int
    let models: [FleetModel]
}

struct FleetModel: Identifiable {
    let id: String
    let name: String
    let share: Double
    let usage: Int
}

struct TopModel: Identifiable {
    let id: String
    let name: String
    let source: String
    let tokens: Int
    let percent: String
}

// MARK: - DashboardViewModel

@MainActor
class DashboardViewModel: ObservableObject {
    private static let logger = Logger(
        subsystem: "com.tokentracker.bar",
        category: "DashboardViewModel"
    )

    // MARK: - Published State

    @Published var period: DateHelpers.Period = .month
    @Published var todaySummary: UsageSummaryResponse?
    @Published var summary: UsageSummaryResponse?
    @Published var rollingSummary: UsageSummaryResponse?
    @Published var totalSummary: UsageSummaryResponse?
    @Published var daily: [DailyEntry] = []
    @Published var monthly: [MonthlyEntry] = []
    @Published var hourly: [HourlyEntry] = []
    @Published var heatmap: HeatmapResponse?
    @Published var modelBreakdown: ModelBreakdownResponse?
    @Published var projectUsage: ProjectUsageResponse?
    @Published var usageLimits: UsageLimitsResponse? = UsageLimitsCache.load()

    @Published var isLoading = false
    @Published var isSyncing = false
    @Published var error: String?
    @Published var serverOnline = false
    @Published var lastRefreshed: Date?
    @Published private(set) var isPopoverVisible = false

    // Derived (cached) data
    @Published private(set) var fleetData: [FleetEntry] = []
    @Published private(set) var topModels: [TopModel] = []

    private var refreshTask: Task<Void, Never>?
    private var resetBoundaryRefreshTask: Task<Void, Never>?
    /// Reentrancy guard shared by every sync path. Unlike the published
    /// `isSyncing` (which only drives the sync animation), this is also set
    /// during silent syncs so concurrent sync requests are still coalesced.
    private var syncInFlight = false
    private var lastBackgroundSyncAt: Date?
    private var lastPopoverOpenSyncAttemptAt: Date?
    private var shouldReloadAfterCurrentLoad = false
    private var isMenuBarSummaryLoading = false
    private var hiddenRefreshInFlight = false
    private var pendingFullRefreshAfterHiddenRefresh = false
    private var pendingUsagePublications = PendingUsagePublicationQueue()
    private var needsFullRefreshOnPopoverOpen = false
    private var summaryPublicationState = SummaryPublicationState()
    private let resetDetector = WeeklyLimitResetDetector()

    // MARK: - Computed Properties

    // Today card (always today)
    var todayTokens: Int { todaySummary?.totals.totalTokens ?? 0 }
    var todayCost: String { TokenFormatter.formatCostFromString(todaySummary?.totals.totalCostUsd) }

    // Rolling stats (always 30-day window)
    var last7dTokens: Int { rollingSummary?.rolling.last7d.totals.billableTotalTokens ?? 0 }
    var last7dActiveDays: Int { rollingSummary?.rolling.last7d.activeDays ?? 0 }
    var last30dTokens: Int { rollingSummary?.rolling.last30d.totals.billableTotalTokens ?? 0 }
    var last30dAvgPerDay: Int { rollingSummary?.rolling.last30d.avgPerActiveDay ?? 0 }

    // All-time total (matches dashboard "Total" period)
    var totalTokens: Int { totalSummary?.totals.totalTokens ?? 0 }
    var totalCost: String { TokenFormatter.formatCostFromString(totalSummary?.totals.totalCostUsd) }

    // MARK: - Period Switching

    func setPopoverVisible(_ isVisible: Bool) {
        guard isPopoverVisible != isVisible else { return }
        isPopoverVisible = isVisible
        if isVisible && hiddenRefreshInFlight {
            pendingFullRefreshAfterHiddenRefresh = true
        }
    }

    func switchPeriod(_ newPeriod: DateHelpers.Period) {
        guard newPeriod != period else { return }
        period = newPeriod
        Task {
            await loadAll()
        }
    }

    // MARK: - Data Loading

    func loadAll() async {
        guard !isLoading else {
            shouldReloadAfterCurrentLoad = true
            return
        }
        isLoading = true
        pendingFullRefreshAfterHiddenRefresh = false
        needsFullRefreshOnPopoverOpen = false
        // A full load starting after a queue event covers every summary that
        // event requested. Events arriving during this load are queued below.
        pendingUsagePublications.removeAll()
        error = nil

        serverOnline = await APIClient.shared.checkServerHealth()
        guard serverOnline else {
            isLoading = false
            await finishDataLoad()
            return
        }

        let range = DateHelpers.rangeForPeriod(period)
        let rollingFrom = DateHelpers.daysAgoString(30)
        let rollingTo = DateHelpers.todayString()
        let totalRange = DateHelpers.rangeForPeriod(.total)

        var errorCount = 0
        var firstError: String?
        let totalFetches = 9

        await withTaskGroup(of: Void.self) { group in
            // Today summary (always today for summary cards)
            group.addTask { @MainActor in
                do {
                    let today = DateHelpers.todayString()
                    let result = try await APIClient.shared.fetchSummaryWithSource(
                        from: today,
                        to: today
                    )
                    self.todaySummary = result.summary
                    self.summaryPublicationState.record(
                        source: result.source,
                        completedAt: result.completedAt,
                        for: .today
                    )
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Period summary (for the selected period — drives chart/models)
            group.addTask { @MainActor in
                do {
                    self.summary = try await APIClient.shared.fetchSummary(from: range.from, to: range.to)
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Rolling summary (always 30-day for the rolling cards)
            group.addTask { @MainActor in
                do {
                    let result = try await APIClient.shared.fetchSummaryWithSource(
                        from: rollingFrom,
                        to: rollingTo
                    )
                    self.rollingSummary = result.summary
                    self.summaryPublicationState.record(
                        source: result.source,
                        completedAt: result.completedAt,
                        for: .rolling
                    )
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // All-time total summary (matches dashboard "Total" range)
            group.addTask { @MainActor in
                do {
                    let result = try await APIClient.shared.fetchSummaryWithSource(
                        from: totalRange.from,
                        to: totalRange.to
                    )
                    self.totalSummary = result.summary
                    self.summaryPublicationState.record(
                        source: result.source,
                        completedAt: result.completedAt,
                        for: .total
                    )
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Trend data: daily always 30-day, plus hourly/monthly for specific periods
            group.addTask { @MainActor in
                do {
                    // Always fetch 30-day daily for week/month chart
                    self.daily = try await APIClient.shared.fetchDaily(from: rollingFrom, to: rollingTo).data
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            group.addTask { @MainActor in
                do {
                    if self.period == .day {
                        self.hourly = try await APIClient.shared.fetchHourly(day: rollingTo).data
                        self.monthly = []
                    } else if self.period == .total {
                        self.monthly = try await APIClient.shared.fetchMonthly(from: range.from, to: range.to).data
                        self.hourly = []
                    } else {
                        self.hourly = []
                        self.monthly = []
                    }
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Heatmap (always full year)
            group.addTask { @MainActor in
                do {
                    self.heatmap = try await APIClient.shared.fetchHeatmap()
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Model breakdown (for selected period)
            group.addTask { @MainActor in
                do {
                    self.modelBreakdown = try await APIClient.shared.fetchModelBreakdown(from: range.from, to: range.to)
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Project usage (for selected period)
            group.addTask { @MainActor in
                do {
                    self.projectUsage = try await APIClient.shared.fetchProjectUsage(from: range.from, to: range.to)
                } catch {
                    errorCount += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
            }
            // Usage limits (best-effort, non-fatal)
            // On hard failure (throw) we retain the previous `usageLimits` record (if any)
            // so the popover/widget/menu stats continue to show the last known progress bars.
            // On success we only overwrite the display record when the response actually
            // contains usable data (prevents losing the last good snapshot on an all-error
            // response from the server). Per-provider errors inside an otherwise-usable
            // response are still respected by the view (those providers are hidden).
            group.addTask { @MainActor in
                await self.refreshUsageLimits()
            }
        }

        if errorCount >= totalFetches {
            self.error = firstError
        }
        if errorCount < totalFetches {
            self.lastRefreshed = Date()
        }

        updateDerivedData()
        isLoading = false

        // Push the latest data to the widget snapshot file so the desktop
        // widgets pick it up on their next timeline reload.
        await WidgetSnapshotWriter.update(from: self)
        await finishDataLoad()
    }

    private func finishDataLoad() async {
        if shouldReloadAfterCurrentLoad {
            shouldReloadAfterCurrentLoad = false
            await loadAll()
            return
        }
        await runPendingQueueRefreshIfNeeded()
    }

    private func runPendingQueueRefreshIfNeeded() async {
        // Keep the publication queued until every owning operation has fully
        // released its state. Otherwise finishDataLoad() can dequeue it while
        // syncInFlight is still true and leave it stranded indefinitely.
        guard let pending = pendingUsagePublications.takeIfReady(
            isLoading: isLoading,
            syncInFlight: syncInFlight,
            hiddenRefreshInFlight: hiddenRefreshInFlight
        ) else { return }
        await refreshAfterUsagePublication(
            pending.sources,
            menuBarSummaries: pending.summaries
        )
    }

    /// Queue writes are already-synced data. Refresh only what is visible in
    /// the menu bar while the popover is closed; a visible popover gets the
    /// normal complete load. Concurrent loads are serialized so an older
    /// response cannot overwrite data fetched after the queue event.
    func refreshAfterQueueChange(menuBarSummaries summaries: MenuBarSummarySelection) async {
        await refreshAfterUsagePublication(.localQueue, menuBarSummaries: summaries)
    }

    /// Account summaries become authoritative only after this machine's queue
    /// offset advances. This avoids re-reading an old cloud aggregate merely
    /// because the local parser wrote its queue first.
    func refreshAfterAccountUpload(menuBarSummaries summaries: MenuBarSummarySelection) async {
        let relevantSummaries = isPopoverVisible ? .all : summaries
        await waitForAccountCacheVisibility(for: relevantSummaries)
        await refreshAfterUsagePublication(.accountUpload, menuBarSummaries: summaries)
    }

    private func waitForAccountCacheVisibility(
        for summaries: MenuBarSummarySelection
    ) async {
        guard !summaries.isEmpty else { return }
        while !Task.isCancelled {
            let slotDelay = UsagePublicationPolicy.remainingAccountCacheDelay(
                state: summaryPublicationState,
                summaries: summaries,
                now: Date()
            )
            let latestAccountRead = await APIClient.shared.latestAccountSummaryReadCompletedAt
            let globalDelay = UsagePublicationPolicy.remainingAccountCacheDelay(
                latestReadCompletedAt: latestAccountRead,
                now: Date()
            )
            let delay = max(slotDelay, globalDelay)
            guard delay > 0 else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            // Re-evaluate after sleeping because another account read may have
            // populated the edge cache while this publication was waiting.
        }
    }

    private func refreshAfterUsagePublication(
        _ source: UsagePublicationSource,
        menuBarSummaries summaries: MenuBarSummarySelection
    ) async {
        guard !UsagePublicationPolicy.shouldQueueRefresh(
            isLoading: isLoading,
            syncInFlight: syncInFlight,
            hiddenRefreshInFlight: hiddenRefreshInFlight
        ) else {
            pendingUsagePublications.enqueue(source, summaries: summaries)
            return
        }

        let affectedSummaries = UsagePublicationPolicy.summariesToRefresh(
            state: summaryPublicationState,
            sources: source,
            requested: .all
        )
        guard !affectedSummaries.isEmpty else { return }

        if isPopoverVisible {
            await loadAll()
        } else {
            needsFullRefreshOnPopoverOpen = true
            let visibleSummaries = affectedSummaries.intersection(summaries)
            guard !visibleSummaries.isEmpty else { return }
            await loadMenuBarSummaries(visibleSummaries)
        }
    }

    private func loadMenuBarSummaries(
        _ summaries: MenuBarSummarySelection,
        checkHealth: Bool = true
    ) async {
        guard !summaries.isEmpty else { return }
        guard !isLoading else { return }

        isLoading = true
        isMenuBarSummaryLoading = true
        if checkHealth {
            serverOnline = await APIClient.shared.checkServerHealth()
            guard serverOnline else {
                isMenuBarSummaryLoading = false
                isLoading = false
                await finishDataLoad()
                return
            }
        }
        var successfulFetches = 0
        var firstError: Error?

        await withTaskGroup(of: Void.self) { group in
            if summaries.contains(.today) || summaries.contains(.rolling) {
                group.addTask { @MainActor in
                    do {
                        let today = DateHelpers.todayString()
                        let result = try await APIClient.shared.fetchSummaryWithSource(
                            from: today,
                            to: today
                        )
                        if summaries.contains(.today) {
                            self.todaySummary = result.summary
                        }
                        // Rolling windows are identical on every summary
                        // response, so today + 7d needs only one request.
                        if summaries.contains(.rolling) {
                            self.rollingSummary = result.summary
                        }
                        self.summaryPublicationState.record(
                            source: result.source,
                            completedAt: result.completedAt,
                            for: summaries.intersection([.today, .rolling])
                        )
                        successfulFetches += 1
                    } catch {
                        if firstError == nil { firstError = error }
                    }
                }
            }

            if summaries.contains(.total) {
                group.addTask { @MainActor in
                    do {
                        let range = DateHelpers.rangeForPeriod(.total)
                        let result = try await APIClient.shared.fetchSummaryWithSource(
                            from: range.from,
                            to: range.to
                        )
                        self.totalSummary = result.summary
                        self.summaryPublicationState.record(
                            source: result.source,
                            completedAt: result.completedAt,
                            for: .total
                        )
                        successfulFetches += 1
                    } catch {
                        if firstError == nil { firstError = error }
                    }
                }
            }
        }

        if successfulFetches > 0 {
            serverOnline = true
        } else if let firstError {
            Self.logger.warning(
                "Queue summary refresh failed: \(firstError.localizedDescription, privacy: .public)"
            )
        }

        isMenuBarSummaryLoading = false
        isLoading = false
        await finishDataLoad()
    }

    // MARK: - Sync

    /// Initial launch: sync data first, then load dashboard.
    /// `silent` keeps the published `isSyncing` flag untouched so opportunistic
    /// syncs (popover open) refresh data without playing the sync animation
    /// over already-cached content.
    func syncThenLoad(silent: Bool = false) async {
        guard !syncInFlight else { return }
        syncInFlight = true
        if !silent { isSyncing = true }
        var didSync = false
        do {
            _ = try await APIClient.shared.triggerSync(auto: true)
            didSync = true
        } catch {
            // Sync failure is non-fatal — proceed with whatever data exists
        }
        if didSync {
            lastBackgroundSyncAt = Date()
        }
        await loadAll()
        syncInFlight = false
        if !silent { isSyncing = false }
        await runPendingQueueRefreshIfNeeded()
    }

    /// The hidden app only needs menu-bar summaries and limits after its
    /// five-minute sync. Full charts are marked dirty and loaded when the user
    /// opens the popover, avoiding nine endpoint requests while idle.
    private func syncThenRefreshHidden(
        menuBarSummaries summaries: MenuBarSummarySelection
    ) async {
        guard !syncInFlight, !hiddenRefreshInFlight else { return }
        syncInFlight = true
        hiddenRefreshInFlight = true
        isSyncing = true
        var didSync = false
        do {
            _ = try await APIClient.shared.triggerSync(auto: true)
            didSync = true
        } catch {
            // Sync failure is non-fatal; visible cached data can still refresh.
        }
        if didSync {
            lastBackgroundSyncAt = Date()
        }
        if isPopoverVisible {
            pendingFullRefreshAfterHiddenRefresh = true
        } else {
            await refreshHiddenDataContents(menuBarSummaries: summaries)
        }
        syncInFlight = false
        isSyncing = false
        await finishHiddenRefresh()
        await runPendingQueueRefreshIfNeeded()
    }

    private func refreshHiddenData(
        menuBarSummaries summaries: MenuBarSummarySelection
    ) async {
        guard !hiddenRefreshInFlight else { return }
        hiddenRefreshInFlight = true
        await refreshHiddenDataContents(menuBarSummaries: summaries)
        await finishHiddenRefresh()
        await runPendingQueueRefreshIfNeeded()
    }

    private func refreshHiddenDataContents(
        menuBarSummaries summaries: MenuBarSummarySelection
    ) async {
        needsFullRefreshOnPopoverOpen = true
        serverOnline = await APIClient.shared.checkServerHealth()
        guard serverOnline,
              !pendingFullRefreshAfterHiddenRefresh,
              !isPopoverVisible else { return }
        if await WidgetSnapshotWriter.hasConfiguredWidgets() {
            // Active desktop widgets are visible even while the popover is
            // closed. Preserve their complete snapshot refresh; the cheaper
            // summary-only path is for installations without configured
            // widgets.
            await loadAll()
            return
        }
        // Publications observed while sync/health work was in flight are
        // covered by the summary request that starts after this point. Events
        // arriving once the request is active are queued by `isLoading` and
        // replayed after it finishes.
        pendingUsagePublications.removeAll()
        await loadMenuBarSummaries(summaries, checkHealth: false)
        guard !pendingFullRefreshAfterHiddenRefresh,
              !isPopoverVisible else { return }
        await refreshUsageLimits()
    }

    private func finishHiddenRefresh() async {
        hiddenRefreshInFlight = false
        guard pendingFullRefreshAfterHiddenRefresh else { return }
        pendingFullRefreshAfterHiddenRefresh = false
        guard isPopoverVisible else { return }
        await loadAll()
    }

    func catchUpAfterWakeOrSessionActive(now: Date = Date()) async {
        let shouldSync = BackgroundRefreshPolicy.shouldRunCatchUpSync(
            now: now,
            lastSyncAt: lastBackgroundSyncAt
        )
        let summaries = MenuBarDisplayPreferences.summarySelection(
            for: MenuBarDisplayPreferences.read()
        )
        if shouldSync {
            if isPopoverVisible {
                await syncThenLoad()
            } else {
                await syncThenRefreshHidden(menuBarSummaries: summaries)
            }
        } else if isPopoverVisible {
            await loadAll()
        } else {
            await refreshHiddenData(menuBarSummaries: summaries)
        }
    }

    func refreshForPopoverOpen(
        now: Date = Date(),
        syncInterval: TimeInterval = BackgroundRefreshPolicy.defaultPopoverOpenSyncInterval,
        loadInterval: TimeInterval = BackgroundRefreshPolicy.defaultPopoverOpenLoadInterval
    ) async {
        if hiddenRefreshInFlight {
            pendingFullRefreshAfterHiddenRefresh = true
            return
        }
        if isLoading {
            // A menu-only publication load does not cover the dashboard the
            // user just opened. Queue one complete load behind it.
            if isMenuBarSummaryLoading {
                shouldReloadAfterCurrentLoad = true
            }
            return
        }
        guard !syncInFlight else { return }
        let shouldSync = BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
            now: now,
            lastAttemptAt: lastPopoverOpenSyncAttemptAt,
            lastSyncAt: lastBackgroundSyncAt,
            syncInterval: syncInterval
        )
        if shouldSync {
            lastPopoverOpenSyncAttemptAt = now
            await syncThenLoad(silent: true)
        } else if needsFullRefreshOnPopoverOpen || BackgroundRefreshPolicy.shouldRunPopoverOpenLoad(
            now: now,
            lastRefreshedAt: lastRefreshed,
            loadInterval: loadInterval
        ) {
            await loadAll()
        }
    }

    func triggerSync() async {
        guard !syncInFlight else { return }
        syncInFlight = true
        isSyncing = true
        do {
            _ = try await APIClient.shared.triggerSync(drain: true)
            lastBackgroundSyncAt = Date()
            await loadAll()
        } catch {
            self.error = error.localizedDescription
        }
        isSyncing = false
        syncInFlight = false
        await runPendingQueueRefreshIfNeeded()
    }

    // MARK: - Auto Refresh

    func startAutoRefresh(
        interval: TimeInterval = BackgroundRefreshPolicy.defaultRefreshInterval,
        syncInterval: TimeInterval = BackgroundRefreshPolicy.defaultSyncInterval
    ) {
        stopAutoRefresh()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                guard !Task.isCancelled, let self else { break }
                let shouldSync = BackgroundRefreshPolicy.shouldRunSync(
                    now: Date(),
                    lastSyncAt: self.lastBackgroundSyncAt,
                    syncInterval: syncInterval
                )
                let summaries = MenuBarDisplayPreferences.summarySelection(
                    for: MenuBarDisplayPreferences.read()
                )
                if shouldSync {
                    await self.syncThenRefreshHidden(menuBarSummaries: summaries)
                } else if self.isPopoverVisible {
                    await self.loadAll()
                } else {
                    await self.refreshHiddenData(menuBarSummaries: summaries)
                }
            }
        }
    }

    func stopAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    // MARK: - Limit-reset celebration

    /// Grace after a window's reset boundary before re-fetching, so the provider
    /// has stamped the new window by the time we ask.
    private static let resetBoundaryGrace: TimeInterval = 10

    /// Fetch usage limits, update the display record, and run reset detection.
    /// On failure retain the previous record (non-fatal, best-effort) so the
    /// popover/widget/menu stats keep showing the last known progress bars.
    /// On success only overwrite the display record when the response actually
    /// contains usable data (prevents losing the last good snapshot on an
    /// all-error response); per-provider errors inside an otherwise-usable
    /// response are still respected by the view (those providers are hidden).
    private func refreshUsageLimits() async {
        do {
            let newLimits = try await APIClient.shared.fetchUsageLimits()
            self.usageLimits = UsageLimitsResponse.displayRecord(
                current: self.usageLimits,
                incoming: newLimits
            )
            UsageLimitsCache.save(newLimits)
            self.detectLimitResets(in: self.usageLimits)
        } catch {
            // Non-fatal: usage limits are best-effort, don't replace the last good record.
            Self.logger.error("Usage limits refresh failed: \(error.localizedDescription, privacy: .public)")
        }
        scheduleResetBoundaryRefresh(for: usageLimits)
    }

    /// Wake up just after the soonest upcoming boundary and re-fetch limits, instead
    /// of waiting out the regular poll interval. Boundaries are (a) a window rollover —
    /// so a reset and its confetti are detected within seconds — and (b) the expiry of
    /// an active 429 cool-down — so a rate-limited panel refreshes the instant the
    /// cool-down lifts rather than up to a poll later. Every limits refresh reschedules,
    /// so at most one boundary task is pending at a time.
    private func scheduleResetBoundaryRefresh(for limits: UsageLimitsResponse?) {
        resetBoundaryRefreshTask?.cancel()
        resetBoundaryRefreshTask = nil
        guard let limits else { return }
        let now = Date().timeIntervalSince1970
        let boundaries = limits.limitWindowReadings().compactMap { $0.resetAt }
            + [limits.soonestCooldownExpiry()].compactMap { $0 }
        guard let upcoming = boundaries.filter({ $0 > now }).min() else { return }
        let delay = upcoming - now + Self.resetBoundaryGrace
        resetBoundaryRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.refreshUsageLimits()
        }
    }

    /// Feed the latest limits into the reset detector. When a window rolls over
    /// after the user had been meaningfully constrained, post `.weeklyLimitReset`
    /// so the status bar can fire confetti (gated behind the user's toggle there).
    private func detectLimitResets(in limits: UsageLimitsResponse?) {
        guard let limits else { return }
        let snapshot = WeeklyLimitResetDetector.loadSnapshot()
        let (events, updated) = resetDetector.evaluate(
            readings: limits.limitWindowReadings(),
            snapshot: snapshot,
            now: Date().timeIntervalSince1970
        )
        WeeklyLimitResetDetector.saveSnapshot(updated)
        guard let first = events.first else { return }
        NotificationCenter.default.post(name: .weeklyLimitReset, object: first)
    }

    // MARK: - Derived Data

    private func updateDerivedData() {
        fleetData = buildFleetData()
        topModels = buildTopModels()
    }

    private func buildFleetData() -> [FleetEntry] {
        guard let sources = modelBreakdown?.sources else { return [] }

        let normalized: [(source: String, totalTokens: Int, totalCost: Double, models: [ModelEntry])] = sources.compactMap { entry in
            let tokens = entry.totals.billableTotalTokens > 0
                ? entry.totals.billableTotalTokens
                : entry.totals.totalTokens
            guard tokens > 0 else { return nil }
            let cost = Double(entry.totals.totalCostUsd ?? "0") ?? 0
            return (source: entry.source, totalTokens: tokens, totalCost: cost, models: entry.models)
        }

        guard !normalized.isEmpty else { return [] }

        let grandTotal = normalized.reduce(0) { $0 + $1.totalTokens }

        return normalized
            .sorted { $0.totalTokens > $1.totalTokens }
            .filter { entry in
                let pct = grandTotal > 0 ? Double(entry.totalTokens) / Double(grandTotal) * 100 : 0
                return pct >= 0.1
            }
            .map { entry in
                let label = entry.source.isEmpty ? "—" : entry.source.uppercased()
                let percentRaw = grandTotal > 0 ? Double(entry.totalTokens) / Double(grandTotal) * 100 : 0
                let totalPercent = String(format: "%.1f", percentRaw)

                let models: [FleetModel] = entry.models.compactMap { model in
                    let modelTokens = model.totals.billableTotalTokens > 0
                        ? model.totals.billableTotalTokens
                        : model.totals.totalTokens
                    guard modelTokens > 0 else { return nil }
                    let share = entry.totalTokens > 0
                        ? (Double(modelTokens) / Double(entry.totalTokens) * 1000).rounded() / 10
                        : 0
                    let name = model.model.isEmpty ? "—" : model.model
                    let id = model.modelId.isEmpty ? name.lowercased() : model.modelId
                    return FleetModel(id: id, name: name, share: share, usage: modelTokens)
                }

                return FleetEntry(
                    label: label,
                    totalPercent: totalPercent,
                    usd: entry.totalCost,
                    usage: entry.totalTokens,
                    models: models
                )
            }
    }

    private func buildTopModels() -> [TopModel] {
        guard let sources = modelBreakdown?.sources, !sources.isEmpty else { return [] }

        var totalsByKey: [String: Int] = [:]
        var nameByKey: [String: String] = [:]
        var sourceByKey: [String: String] = [:]
        var nameWeight: [String: Int] = [:]
        var totalTokensAll = 0

        for source in sources {
            for model in source.models {
                let tokens = model.totals.billableTotalTokens
                guard tokens > 0 else { continue }
                totalTokensAll += tokens

                let name = model.model.isEmpty ? "—" : model.model
                let key = name.lowercased().trimmingCharacters(in: .whitespaces)
                guard !key.isEmpty else { continue }

                totalsByKey[key, default: 0] += tokens
                let currentWeight = nameWeight[key] ?? 0
                if tokens >= currentWeight {
                    nameWeight[key] = tokens
                    nameByKey[key] = name
                    sourceByKey[key] = source.source
                }
            }
        }

        guard !totalsByKey.isEmpty else { return [] }

        let knownTotal = totalsByKey.values.reduce(0, +)
        let totalTokens = totalTokensAll > 0 ? totalTokensAll : knownTotal

        return totalsByKey
            .map { key, tokens -> TopModel in
                let percent = totalTokens > 0
                    ? String(format: "%.1f", Double(tokens) / Double(totalTokens) * 100)
                    : "0.0"
                return TopModel(
                    id: key,
                    name: nameByKey[key] ?? "—",
                    source: sourceByKey[key] ?? "",
                    tokens: tokens,
                    percent: percent
                )
            }
            .filter { $0.tokens > 0 }
            .sorted { lhs, rhs in
                if lhs.tokens != rhs.tokens { return lhs.tokens > rhs.tokens }
                return lhs.name.localizedCompare(rhs.name) == .orderedAscending
            }
            .prefix(5)
            .map { $0 }
    }
}
