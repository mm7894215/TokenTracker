import SwiftUI
import WidgetKit

// Hero-number summary widget. No header chrome, no "updated" footer — the
// widget gallery already labels the tile and the OS already shows reload
// state. Each size promotes ONE primary number and lets the rest of the
// information serve it. Static configuration: each widget kind has a
// fixed, focused job (no period/metric switcher).

struct SummaryWidget: Widget {
    let kind: String = "TokenTrackerSummaryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            SummaryWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Usage")
        .description("Today's tokens at a glance, with trend.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct SummaryWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StaticEntry

    var body: some View {
        switch family {
        case .systemSmall:      SmallView(snap: entry.snapshot)
        case .systemMedium:     MediumView(snap: entry.snapshot)
        case .systemLarge:      LargeView(snap: entry.snapshot)
        case .systemExtraLarge: LargeView(snap: entry.snapshot)
        default:                MediumView(snap: entry.snapshot)
        }
    }
}

// MARK: - Small (2x2): Today only

private struct SmallView: View {
    let snap: WidgetSnapshot

    var body: some View {
        let hasData = snap.today.tokens > 0

        VStack(alignment: .leading, spacing: 0) {
            Text("TODAY")
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            Text(hasData ? WidgetFormat.compact(snap.today.tokens) : "—")
                .font(.system(size: 38, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.bottom, 2)

            Text(WidgetFormat.delta(snap.todayDeltaPercent))
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(WidgetFormat.deltaColor(snap.todayDeltaPercent))

            Spacer(minLength: 0)

            Text("vs. yesterday")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Medium (4x2): Today + 7d, with sparkline

private struct MediumView: View {
    let snap: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                HeroBlock(
                    label: "TODAY",
                    value: WidgetFormat.compact(snap.today.tokens),
                    sub: WidgetFormat.delta(snap.todayDeltaPercent),
                    subColor: WidgetFormat.deltaColor(snap.todayDeltaPercent)
                )
                Spacer(minLength: 12)
                HeroBlock(
                    label: "7 DAYS",
                    value: WidgetFormat.compact(snap.last7d.tokens),
                    sub: WidgetFormat.cost(snap.last7d.costUsd),
                    subColor: .secondary,
                    alignment: .trailing
                )
            }

            Spacer(minLength: 8)

            SparklineView(points: Array(snap.dailyTrend.suffix(14)))
                .frame(height: 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - Large (4x4): Today + 7d + 30d + bar chart + top 3 models

private struct LargeView: View {
    let snap: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 0) {
                HeroBlock(
                    label: "TODAY",
                    value: WidgetFormat.compact(snap.today.tokens),
                    sub: WidgetFormat.delta(snap.todayDeltaPercent),
                    subColor: WidgetFormat.deltaColor(snap.todayDeltaPercent),
                    size: .compact
                )
                Spacer(minLength: 12)
                HeroBlock(
                    label: "7 DAYS",
                    value: WidgetFormat.compact(snap.last7d.tokens),
                    sub: WidgetFormat.cost(snap.last7d.costUsd),
                    subColor: .secondary,
                    alignment: .center,
                    size: .compact
                )
                Spacer(minLength: 12)
                HeroBlock(
                    label: "30 DAYS",
                    value: WidgetFormat.compact(snap.last30d.tokens),
                    sub: WidgetFormat.cost(snap.last30d.costUsd),
                    subColor: .secondary,
                    alignment: .trailing,
                    size: .compact
                )
            }

            BarTrendChart(points: snap.dailyTrend)
                .frame(maxWidth: .infinity, minHeight: 56)

            VStack(spacing: 6) {
                ForEach(Array(snap.topModels.prefix(3).enumerated()), id: \.element.id) { idx, m in
                    InlineModelRow(rank: idx, model: m)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Hero number block

private struct HeroBlock: View {
    let label: String
    let value: String
    let sub: String
    let subColor: Color
    var alignment: HorizontalAlignment = .leading
    var size: HeroSize = .large

    enum HeroSize {
        case large   // medium widget: 2 blocks side by side
        case compact // large widget: 3 blocks side by side

        var valueFont: CGFloat { self == .large ? 28 : 24 }
    }

    var body: some View {
        VStack(alignment: alignment, spacing: 3) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: size.valueFont, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(sub)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(subColor)
                .lineLimit(1)
        }
    }
}

// Simple inline row used by Large to surface top models without the
// separate Top Models widget being installed.
private struct InlineModelRow: View {
    let rank: Int
    let model: SnapshotModelEntry

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(WidgetTheme.modelDot(rank))
                .frame(width: 6, height: 6)
            Text(model.name)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Text(WidgetFormat.compact(model.tokens))
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text(String(format: "%.0f%%", model.sharePercent))
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(.tertiary)
                .monospacedDigit()
                .frame(width: 30, alignment: .trailing)
        }
    }
}
