import AppIntents
import WidgetKit

// MARK: - Period

enum WidgetPeriod: String, AppEnum {
    case today
    case last7d
    case last30d
    case selected

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Period"
    static let caseDisplayRepresentations: [WidgetPeriod: DisplayRepresentation] = [
        .today:    "Today",
        .last7d:   "Last 7 days",
        .last30d:  "Last 30 days",
        .selected: "Dashboard period"
    ]
}

// MARK: - Metric

enum WidgetMetric: String, AppEnum {
    case tokens
    case cost
    case both

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Metric"
    static let caseDisplayRepresentations: [WidgetMetric: DisplayRepresentation] = [
        .tokens: "Tokens",
        .cost:   "Cost",
        .both:   "Tokens + Cost"
    ]
}

// MARK: - Configuration intent

struct TokenTrackerWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "TokenTracker"
    static let description = IntentDescription("Configure which period and metric the widget shows.")

    @Parameter(title: "Period", default: .last7d)
    var period: WidgetPeriod

    @Parameter(title: "Metric", default: .both)
    var metric: WidgetMetric

    init() {}

    init(period: WidgetPeriod, metric: WidgetMetric = .both) {
        self.period = period
        self.metric = metric
    }
}

// MARK: - Snapshot lookups

extension WidgetSnapshot {
    func totals(for period: WidgetPeriod) -> PeriodTotals {
        switch period {
        case .today:    return today
        case .last7d:   return last7d
        case .last30d:  return last30d
        case .selected: return selected
        }
    }

    /// Returns the number of trailing daily-trend points appropriate for the
    /// requested period — used by the chart widget.
    func trend(for period: WidgetPeriod) -> [DailyPoint] {
        let take: Int
        switch period {
        case .today:    take = 1
        case .last7d:   take = 7
        case .last30d:  take = 30
        case .selected: take = 30
        }
        return Array(dailyTrend.suffix(take))
    }
}

extension WidgetPeriod {
    var shortLabel: String {
        switch self {
        case .today:    return "Today"
        case .last7d:   return "7d"
        case .last30d:  return "30d"
        case .selected: return "Period"
        }
    }
}
