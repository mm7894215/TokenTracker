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
        .configurationDisplayName(WidgetStrings.heatmapName)
        .description(WidgetStrings.heatmapDescription)
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
                        Text(WidgetStrings.streak(streak))
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundColor(.accentColor)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.16), in: Capsule())
                    }
                }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Show all-time tokens so the number lines up with the
                // all-time active-days count shown next to it.
                let totalTokens = snap.total.tokens > 0 ? snap.total.tokens : snap.last30d.tokens
                Text(WidgetFormat.compact(totalTokens))
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundColor(.primary)
                    .monospacedDigit()
                Text(WidgetStrings.tokensActiveDays(activeDays: snap.heatmap.activeDays))
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                Spacer(minLength: 0)
            }
        }
    }
}
