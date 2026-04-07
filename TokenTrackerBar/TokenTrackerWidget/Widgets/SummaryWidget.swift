import SwiftUI
import WidgetKit
import AppIntents

struct SummaryWidget: Widget {
    let kind: String = "TokenTrackerSummaryWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: TokenTrackerWidgetIntent.self,
            provider: TokenTrackerProvider()
        ) { entry in
            SummaryWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Usage Summary")
        .description("Tokens, cost, and trend at a glance. Pick which period to show.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct SummaryWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: TokenTrackerEntry

    var body: some View {
        switch family {
        case .systemSmall:      SmallView(entry: entry)
        case .systemMedium:     MediumView(entry: entry)
        case .systemLarge:      LargeView(entry: entry)
        case .systemExtraLarge: ExtraLargeView(entry: entry)
        default:                MediumView(entry: entry)
        }
    }
}

// MARK: - Small

private struct SmallView: View {
    let entry: TokenTrackerEntry

    var body: some View {
        let totals = entry.snapshot.totals(for: entry.configuration.period)
        VStack(alignment: .leading, spacing: 6) {
            WidgetHeader(title: "TokenTracker", subtitle: entry.configuration.period.shortLabel)

            Spacer(minLength: 0)

            switch entry.configuration.metric {
            case .tokens:
                WidgetStat(label: "Tokens", value: WidgetFormat.compact(totals.tokens))
            case .cost:
                WidgetStat(label: "Cost", value: WidgetFormat.cost(totals.costUsd))
            case .both:
                WidgetStat(label: "Tokens", value: WidgetFormat.compact(totals.tokens),
                           sub: WidgetFormat.cost(totals.costUsd))
            }

            Spacer(minLength: 0)

            SparklineView(points: entry.snapshot.trend(for: entry.configuration.period))
                .frame(height: 22)

            WidgetFooter(updated: entry.snapshot.generatedAt, serverOnline: entry.snapshot.serverOnline)
        }
    }
}

// MARK: - Medium

private struct MediumView: View {
    let entry: TokenTrackerEntry

    var body: some View {
        let snap = entry.snapshot
        let primary = snap.totals(for: entry.configuration.period)
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "TokenTracker",
                         subtitle: entry.configuration.period.shortLabel)

            HStack(alignment: .top, spacing: 14) {
                WidgetStat(
                    label: entry.configuration.period.shortLabel,
                    value: WidgetFormat.compact(primary.tokens),
                    sub: WidgetFormat.cost(primary.costUsd)
                )
                Divider().frame(height: 36)
                WidgetStat(label: "7d", value: WidgetFormat.compact(snap.last7d.tokens),
                           sub: "\(snap.last7d.activeDays) active days")
                Divider().frame(height: 36)
                WidgetStat(label: "30d", value: WidgetFormat.compact(snap.last30d.tokens),
                           sub: "\(snap.last30d.activeDays) active days")
            }

            SparklineView(points: snap.trend(for: .last30d))
                .frame(maxWidth: .infinity, minHeight: 28)

            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}

// MARK: - Large

private struct LargeView: View {
    let entry: TokenTrackerEntry

    var body: some View {
        let snap = entry.snapshot
        let primary = snap.totals(for: entry.configuration.period)

        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(title: "TokenTracker",
                         subtitle: entry.configuration.period.shortLabel)

            HStack(spacing: 12) {
                WidgetStat(label: entry.configuration.period.shortLabel,
                           value: WidgetFormat.compact(primary.tokens),
                           sub: WidgetFormat.cost(primary.costUsd))
                Divider().frame(height: 40)
                WidgetStat(label: "7d", value: WidgetFormat.compact(snap.last7d.tokens),
                           sub: "\(snap.last7d.activeDays) active")
                Divider().frame(height: 40)
                WidgetStat(label: "30d", value: WidgetFormat.compact(snap.last30d.tokens),
                           sub: "\(snap.last30d.activeDays) active")
            }

            BarTrendChart(points: snap.trend(for: .last30d))
                .frame(maxWidth: .infinity, minHeight: 60)

            // Top models
            VStack(alignment: .leading, spacing: 4) {
                Text("TOP MODELS")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .tracking(0.4)
                ForEach(Array(snap.topModels.prefix(4).enumerated()), id: \.element.id) { idx, m in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(WidgetTheme.modelDot(idx))
                            .frame(width: 6, height: 6)
                        Text(m.name)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(WidgetFormat.compact(m.tokens))
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        Text(String(format: "%.0f%%", m.sharePercent))
                            .font(.system(size: 10, design: .rounded))
                            .foregroundStyle(.tertiary)
                            .frame(width: 30, alignment: .trailing)
                            .monospacedDigit()
                    }
                }
            }

            Spacer(minLength: 0)
            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}

// MARK: - Extra Large

private struct ExtraLargeView: View {
    let entry: TokenTrackerEntry

    var body: some View {
        let snap = entry.snapshot
        let primary = snap.totals(for: entry.configuration.period)

        VStack(alignment: .leading, spacing: 12) {
            WidgetHeader(title: "TokenTracker",
                         subtitle: entry.configuration.period.shortLabel)

            HStack(alignment: .top, spacing: 16) {
                // LEFT: stats + chart
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 14) {
                        WidgetStat(label: entry.configuration.period.shortLabel,
                                   value: WidgetFormat.compact(primary.tokens),
                                   sub: WidgetFormat.cost(primary.costUsd))
                        Divider().frame(height: 40)
                        WidgetStat(label: "7d", value: WidgetFormat.compact(snap.last7d.tokens),
                                   sub: "\(snap.last7d.activeDays) active")
                        Divider().frame(height: 40)
                        WidgetStat(label: "30d", value: WidgetFormat.compact(snap.last30d.tokens),
                                   sub: "\(snap.last30d.activeDays) active")
                    }

                    BarTrendChart(points: snap.trend(for: .last30d))
                        .frame(maxWidth: .infinity, minHeight: 70)

                    // Heatmap snippet
                    HeatmapGridView(payload: snap.heatmap, maxWeeks: 30)
                        .frame(height: 60)
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)

                Divider()

                // RIGHT: top models + sources
                VStack(alignment: .leading, spacing: 10) {
                    Text("TOP MODELS")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .tracking(0.4)
                    ForEach(Array(snap.topModels.prefix(5).enumerated()), id: \.element.id) { idx, m in
                        HStack(spacing: 6) {
                            Circle().fill(WidgetTheme.modelDot(idx)).frame(width: 6, height: 6)
                            Text(m.name)
                                .font(.system(size: 11, weight: .medium))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 4)
                            Text(WidgetFormat.compact(m.tokens))
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }

                    Divider()

                    Text("SOURCES")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .tracking(0.4)
                    ForEach(snap.sources.prefix(5)) { src in
                        SourceDot(
                            source: src.source,
                            label: src.source.uppercased(),
                            value: "\(WidgetFormat.compact(src.tokens)) · \(String(format: "%.0f%%", src.sharePercent))"
                        )
                    }
                }
                .frame(width: 240, alignment: .topLeading)
            }

            Spacer(minLength: 0)
            WidgetFooter(updated: snap.generatedAt, serverOnline: snap.serverOnline)
        }
    }
}
