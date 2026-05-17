import SwiftUI
import WidgetKit

// Ranked-bar widget. The list IS the widget — no title, no footer. The
// rank position, color dot, and bar length carry the hierarchy.

struct TopModelsWidget: Widget {
    let kind: String = "TokenTrackerTopModelsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            TopModelsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName(WidgetStrings.topModelsName)
        .description(WidgetStrings.topModelsDescription)
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct TopModelsWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StaticEntry

    private var limit: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 6
        }
    }

    var body: some View {
        let models = Array(entry.snapshot.topModels.prefix(limit))

        if models.isEmpty {
            WidgetEmptyState(message: WidgetStrings.noModelUsage)
        } else {
            VStack(alignment: .leading, spacing: family == .systemSmall ? 10 : 13) {
                ForEach(Array(models.enumerated()), id: \.element.id) { idx, m in
                    ModelBar(rank: idx, model: m, compact: family == .systemSmall)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

private struct ModelBar: View {
    let rank: Int
    let model: SnapshotModelEntry
    let compact: Bool

    var body: some View {
        let share = max(0, min(100, model.sharePercent)) / 100.0
        let dotColor = WidgetTheme.modelDot(rank)

        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
                Text(model.name)
                    .font(.system(size: compact ? 10 : 11, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Text(WidgetFormat.compact(model.tokens))
                    .font(.system(size: compact ? 10 : 11, weight: .semibold, design: .rounded))
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                Text(String(format: "%.0f%%", model.sharePercent))
                    .font(.system(size: compact ? 9 : 10, weight: .semibold, design: .rounded))
                    .foregroundColor(Color.secondary.opacity(0.55))
                    .monospacedDigit()
                    .frame(width: compact ? 24 : 28, alignment: .trailing)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(WidgetTheme.limitTrack)
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(dotColor)
                        .frame(width: max(geo.size.width * share, share > 0 ? 4 : 0))
                }
            }
            .frame(height: compact ? 4 : 5)
        }
    }
}
