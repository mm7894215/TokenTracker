import SwiftUI
import WidgetKit

struct HeatmapWidget: Widget {
    let kind: String = "TokenTrackerHeatmapWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            HeatmapWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Activity Heatmap")
        .description("GitHub-style daily activity calendar.")
        .supportedFamilies([.systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct HeatmapWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StaticEntry

    var body: some View {
        let snap = entry.snapshot
        let weeks: Int
        switch family {
        case .systemMedium: weeks = 26
        case .systemLarge: weeks = 40
        default: weeks = 52
        }

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                WidgetHeader(title: "Activity", icon: "square.grid.3x3.fill")
                Spacer()
                Text("\(snap.heatmap.streakDays)d streak")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tint)
            }

            HStack(spacing: 14) {
                WidgetStat(label: "Active", value: "\(snap.heatmap.activeDays)", sub: "days")
                Divider().frame(height: 30)
                WidgetStat(label: "30d", value: WidgetFormat.compact(snap.last30d.tokens))
                Divider().frame(height: 30)
                WidgetStat(label: "7d", value: WidgetFormat.compact(snap.last7d.tokens))
            }

            HeatmapGridView(payload: snap.heatmap, maxWeeks: weeks)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}
