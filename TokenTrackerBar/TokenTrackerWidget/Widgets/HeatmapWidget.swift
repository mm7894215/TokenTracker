import SwiftUI
import WidgetKit

// Hero-grid heatmap widget. The grid IS the widget — no title, no stat row,
// just the calendar filling almost the whole tile with a tiny streak label
// in the top corner and a one-line summary at the bottom.

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

    private var weeks: Int {
        switch family {
        case .systemMedium: return 26
        case .systemLarge: return 40
        default: return 52
        }
    }

    var body: some View {
        let snap = entry.snapshot
        let streak = snap.heatmap.streakDays

        VStack(alignment: .leading, spacing: 12) {
            HeatmapGridView(payload: snap.heatmap, maxWeeks: weeks)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .topTrailing) {
                    if streak > 0 {
                        Text("\(streak)d streak")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(.tint)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.16), in: Capsule())
                    }
                }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(WidgetFormat.compact(snap.last30d.tokens))
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(.primary)
                    .monospacedDigit()
                Text("tokens · \(snap.heatmap.activeDays) active days")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }
}
