import SwiftUI
import WidgetKit

struct UsageLimitsWidget: Widget {
    let kind: String = "TokenTrackerLimitsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            UsageLimitsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Usage Limits")
        .description("Rate limits for Claude, Codex, Cursor, Gemini, and more.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct UsageLimitsWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StaticEntry

    var body: some View {
        let limits = entry.snapshot.limits
        let max = family == .systemMedium ? 4 : 8

        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "Usage Limits", icon: "gauge.with.dots.needle.67percent")

            if limits.isEmpty {
                WidgetEmptyState(message: "No configured providers")
            } else {
                VStack(spacing: family == .systemMedium ? 8 : 10) {
                    ForEach(limits.prefix(max)) { limit in
                        LimitBarRow(limit: limit)
                    }
                }
            }

            Spacer(minLength: 0)
            WidgetFooter(updated: entry.snapshot.generatedAt, serverOnline: entry.snapshot.serverOnline)
        }
    }
}
