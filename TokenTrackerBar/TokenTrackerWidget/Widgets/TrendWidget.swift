import SwiftUI
import WidgetKit

struct TrendWidget: Widget {
    let kind: String = "TokenTrackerTrendWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: TokenTrackerWidgetIntent.self,
            provider: TokenTrackerProvider()
        ) { entry in
            TrendWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Token Trend")
        .description("Daily token usage as a bar chart.")
        .supportedFamilies([.systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct TrendWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: TokenTrackerEntry

    var body: some View {
        let snap = entry.snapshot
        let points = snap.trend(for: entry.configuration.period.actualOrLast30d)
        let totals = snap.totals(for: entry.configuration.period)

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                WidgetHeader(title: "Token Trend",
                             subtitle: entry.configuration.period.shortLabel,
                             icon: "chart.bar.fill")
            }

            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(WidgetFormat.compact(totals.tokens))
                    .font(.system(size: family == .systemMedium ? 22 : 26, weight: .bold, design: .rounded))
                    .foregroundStyle(.primary)
                Text(WidgetFormat.cost(totals.costUsd))
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                Spacer()
                if let peak = points.max(by: { $0.totalTokens < $1.totalTokens }) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text("PEAK")
                            .font(.system(size: 8, weight: .semibold))
                            .tracking(0.4)
                            .foregroundStyle(.secondary)
                        Text(WidgetFormat.compact(peak.totalTokens))
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                    }
                }
            }

            BarTrendChart(points: points)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}

private extension WidgetPeriod {
    /// Trend chart only makes sense over a window — collapse "today" onto
    /// the 30-day daily series.
    var actualOrLast30d: WidgetPeriod {
        switch self {
        case .today: return .last30d
        default:     return self
        }
    }
}
