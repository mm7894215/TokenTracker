import Foundation
import WidgetKit
import os

/// Bridge between the live `DashboardViewModel` and the on-disk widget
/// snapshot file. Called from `DashboardViewModel.loadAll()` after every
/// successful refresh, and again after a manual sync.
///
/// Behavior:
///   1. Translates view model state into a `WidgetSnapshot`
///   2. Writes it atomically to the App Group container
///   3. Tells WidgetKit to reload all widget timelines
@MainActor
enum WidgetSnapshotWriter {

    private static let logger = Logger(subsystem: "com.tokentracker.bar", category: "WidgetSnapshotWriter")

    /// Immutable snapshot of the fields we read off `DashboardViewModel`.
    /// Captured synchronously on the main actor BEFORE we suspend on any
    /// async work, so a concurrent `loadAll()` running while we're awaiting
    /// the cost fetches can't smear two refreshes together in one widget
    /// snapshot.
    private struct VMInputs {
        let serverOnline: Bool
        let todaySummary: UsageSummaryResponse?
        let summary: UsageSummaryResponse?
        let rollingSummary: UsageSummaryResponse?
        let daily: [DailyEntry]
        let topModels: [TopModel]
        let fleetData: [FleetEntry]
        let heatmap: HeatmapResponse?
        let usageLimits: UsageLimitsResponse?
    }

    static func update(from vm: DashboardViewModel) async {
        // STEP 1 — synchronously freeze every VM field we will need. After
        // this point we never touch `vm` again. This is the fix for the
        // race where a second loadAll() could mutate the view model while
        // we're awaiting the cost fetches below, producing a snapshot that
        // mixed two different refreshes.
        let inputs = VMInputs(
            serverOnline: vm.serverOnline,
            todaySummary: vm.todaySummary,
            summary: vm.summary,
            rollingSummary: vm.rollingSummary,
            daily: vm.daily,
            topModels: vm.topModels,
            fleetData: vm.fleetData,
            heatmap: vm.heatmap,
            usageLimits: vm.usageLimits
        )

        // STEP 2 — the dashboard's `rollingSummary` does NOT include cost
        // (the /tokentracker-usage-summary endpoint omits it from
        // `rolling.*`). Fire two extra parallel summary calls scoped to
        // 7-day and 30-day ranges so the widget can show real cost numbers.
        async let last7dCost = fetchRangeCost(daysBack: 6)
        async let last30dCost = fetchRangeCost(daysBack: 29)
        let (cost7d, cost30d) = await (last7dCost, last30dCost)

        let snapshot = buildSnapshot(from: inputs, cost7d: cost7d, cost30d: cost30d)
        let ok = WidgetSnapshotStore.write(snapshot)
        if ok {
            WidgetCenter.shared.reloadAllTimelines()
            logger.debug("Widget snapshot written and timelines reloaded")
        } else {
            logger.warning("Failed to write widget snapshot")
        }
    }

    /// Fetches a `UsageSummaryResponse` for `[N days ago, today]` and pulls
    /// out the top-level `total_cost_usd`. Returns 0 on any failure so the
    /// widget keeps rendering rather than getting stuck on an error path.
    private static func fetchRangeCost(daysBack: Int) async -> Double {
        let from = DateHelpers.daysAgoString(daysBack)
        let to = DateHelpers.todayString()
        do {
            let resp = try await APIClient.shared.fetchSummary(from: from, to: to)
            return parseCost(resp.totals.totalCostUsd)
        } catch {
            logger.warning("widget cost fetch \(daysBack)d failed: \(error.localizedDescription)")
            return 0
        }
    }

    // MARK: - Translation

    private static func buildSnapshot(
        from inputs: VMInputs,
        cost7d: Double,
        cost30d: Double
    ) -> WidgetSnapshot {
        var last7d = rollingTotals(from: inputs.rollingSummary?.rolling.last7d)
        last7d.costUsd = cost7d
        var last30d = rollingTotals(from: inputs.rollingSummary?.rolling.last30d)
        last30d.costUsd = cost30d

        return WidgetSnapshot(
            generatedAt: Date(),
            serverOnline: inputs.serverOnline,
            today: periodTotals(from: inputs.todaySummary),
            last7d: last7d,
            last30d: last30d,
            selected: periodTotals(from: inputs.summary),
            dailyTrend: trendPoints(from: inputs.daily),
            topModels: topModelEntries(from: inputs.topModels),
            sources: sourceEntries(from: inputs.fleetData),
            heatmap: heatmapPayload(from: inputs.heatmap),
            limits: limitProviders(from: inputs.usageLimits)
        )
    }

    // MARK: - Helpers

    private static func parseCost(_ s: String?) -> Double {
        guard let s, let v = Double(s) else { return 0 }
        return v
    }

    private static func periodTotals(from summary: UsageSummaryResponse?) -> PeriodTotals {
        guard let t = summary?.totals else { return .empty }
        let billable = t.billableTotalTokens > 0 ? t.billableTotalTokens : t.totalTokens
        return PeriodTotals(
            tokens: billable,
            costUsd: parseCost(t.totalCostUsd),
            conversations: t.conversationCount,
            activeDays: 0
        )
    }

    private static func rollingTotals(from window: RollingPeriod?) -> PeriodTotals {
        guard let window else { return .empty }
        return PeriodTotals(
            tokens: window.totals.billableTotalTokens,
            costUsd: 0, // rolling endpoint does not return cost
            conversations: window.totals.conversationCount,
            activeDays: window.activeDays
        )
    }

    private static func trendPoints(from daily: [DailyEntry]) -> [DailyPoint] {
        // Take last 30 days, parse the YYYY-MM-DD string into a Date.
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current

        return daily.suffix(30).compactMap { entry in
            guard let date = formatter.date(from: entry.day) else { return nil }
            let tokens = entry.billableTotalTokens > 0 ? entry.billableTotalTokens : entry.totalTokens
            return DailyPoint(day: date, totalTokens: tokens, costUsd: 0)
        }
    }

    private static func topModelEntries(from models: [TopModel]) -> [SnapshotModelEntry] {
        models.prefix(5).map { m in
            SnapshotModelEntry(
                id: m.id,
                name: m.name,
                source: m.source,
                tokens: m.tokens,
                sharePercent: Double(m.percent) ?? 0
            )
        }
    }

    private static func sourceEntries(from fleet: [FleetEntry]) -> [SnapshotSourceEntry] {
        fleet.map { entry in
            SnapshotSourceEntry(
                source: entry.label.lowercased(),
                tokens: entry.usage,
                costUsd: entry.usd,
                sharePercent: Double(entry.totalPercent) ?? 0
            )
        }
    }

    private static func heatmapPayload(from heatmap: HeatmapResponse?) -> HeatmapPayload {
        guard let heatmap else { return .empty }
        // Compress to a 2D Int matrix of levels — one entry per day, 7 per week.
        // Missing days become level 0.
        let weeks: [[Int]] = heatmap.weeks.map { week in
            var row = Array(repeating: 0, count: 7)
            for (idx, cell) in week.enumerated() where idx < 7 {
                if let cell {
                    row[idx] = max(0, min(4, cell.level))
                }
            }
            return row
        }
        return HeatmapPayload(
            weeks: weeks,
            activeDays: heatmap.activeDays,
            streakDays: heatmap.streakDays
        )
    }

    // MARK: - Limits flattening
    //
    // The native limits API exposes per-provider structs with several
    // optional windows each. We flatten them into a uniform list so the
    // widget can render generically.

    private static func limitProviders(from limits: UsageLimitsResponse?) -> [LimitProvider] {
        guard let limits else { return [] }
        var out: [LimitProvider] = []

        // Claude — `utilization` from /tokentracker-usage-limits is a 0–100
        // percentage, not a 0–1 fraction. Divide by 100 to match the
        // LimitProvider contract (and what every other provider here does).
        if limits.claude.configured {
            if let w = limits.claude.fiveHour {
                out.append(LimitProvider(source: "claude", label: "Claude · 5h",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
            if let w = limits.claude.sevenDay {
                out.append(LimitProvider(source: "claude", label: "Claude · 7d",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
            if let w = limits.claude.sevenDayOpus {
                out.append(LimitProvider(source: "claude", label: "Claude · 7d Opus",
                                         fraction: w.utilization / 100.0,
                                         resetsAt: parseISO(w.resetsAt)))
            }
        }

        // Codex
        if limits.codex.configured {
            if let w = limits.codex.primaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · 5h",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
            if let w = limits.codex.secondaryWindow {
                out.append(LimitProvider(source: "codex", label: "Codex · weekly",
                                         fraction: Double(w.usedPercent) / 100.0,
                                         resetsAt: parseEpoch(w.resetAt)))
            }
        }

        // Cursor
        if limits.cursor.configured {
            if let w = limits.cursor.primaryWindow {
                out.append(LimitProvider(source: "cursor", label: "Cursor",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Gemini
        if limits.gemini.configured {
            if let w = limits.gemini.primaryWindow {
                out.append(LimitProvider(source: "gemini", label: "Gemini",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Kiro
        if limits.kiro.configured {
            if let w = limits.kiro.primaryWindow {
                out.append(LimitProvider(source: "kiro", label: "Kiro",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        // Antigravity
        if limits.antigravity.configured {
            if let w = limits.antigravity.primaryWindow {
                out.append(LimitProvider(source: "antigravity", label: "Antigravity",
                                         fraction: w.usedPercent / 100.0,
                                         resetsAt: parseISO(w.resetAt)))
            }
        }

        return out
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        if let d = iso8601.date(from: s) { return d }
        // Retry without fractional seconds
        let alt = ISO8601DateFormatter()
        alt.formatOptions = [.withInternetDateTime]
        return alt.date(from: s)
    }

    private static func parseEpoch(_ epoch: Int?) -> Date? {
        guard let epoch else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(epoch))
    }
}
