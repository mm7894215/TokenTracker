import SwiftUI
import WidgetKit

struct TopModelsWidget: Widget {
    let kind: String = "TokenTrackerTopModelsWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: TokenTrackerWidgetIntent.self,
            provider: TokenTrackerProvider()
        ) { entry in
            TopModelsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Top Models")
        .description("Models with the highest token usage.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct TopModelsWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: TokenTrackerEntry

    var body: some View {
        let snap = entry.snapshot
        let limit: Int
        switch family {
        case .systemSmall: limit = 3
        case .systemMedium: limit = 4
        default: limit = 6
        }
        let models = Array(snap.topModels.prefix(limit))

        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "Top Models",
                         subtitle: entry.configuration.period.shortLabel,
                         icon: "cpu.fill")

            if models.isEmpty {
                WidgetEmptyState(message: "No model usage yet")
            } else {
                VStack(spacing: family == .systemSmall ? 6 : 8) {
                    ForEach(Array(models.enumerated()), id: \.element.id) { idx, m in
                        ModelRow(rank: idx, model: m, compact: family == .systemSmall)
                    }
                }
            }

            Spacer(minLength: 0)
            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}

private struct ModelRow: View {
    let rank: Int
    let model: SnapshotModelEntry
    let compact: Bool

    var body: some View {
        let share = max(0, min(100, model.sharePercent)) / 100.0

        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle()
                    .fill(WidgetTheme.modelDot(rank))
                    .frame(width: 7, height: 7)
                Text(model.name)
                    .font(.system(size: compact ? 10 : 11, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Text(WidgetFormat.compact(model.tokens))
                    .font(.system(size: compact ? 10 : 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if !compact {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(WidgetTheme.limitTrack)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(WidgetTheme.modelDot(rank))
                            .frame(width: geo.size.width * share)
                    }
                }
                .frame(height: 3)
            }
        }
    }
}
