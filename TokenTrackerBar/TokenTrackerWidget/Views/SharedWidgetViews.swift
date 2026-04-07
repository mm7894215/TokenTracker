import SwiftUI
import WidgetKit

// MARK: - Header

struct WidgetHeader: View {
    let title: String
    var subtitle: String? = nil
    var icon: String = "bolt.circle.fill"

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tint)
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.primary)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Stat block

struct WidgetStat: View {
    let label: String
    let value: String
    var sub: String? = nil
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
                .tracking(0.4)
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let sub {
                Text(sub)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Sparkline

struct SparklineView: View {
    let points: [DailyPoint]

    var body: some View {
        GeometryReader { geo in
            let values = points.map { Double($0.totalTokens) }
            let maxV = max(values.max() ?? 1, 1)
            let minV = values.min() ?? 0
            let range = max(maxV - minV, 1)

            ZStack(alignment: .bottomLeading) {
                // Filled gradient
                Path { p in
                    guard !values.isEmpty else { return }
                    let stepX = geo.size.width / CGFloat(max(values.count - 1, 1))
                    p.move(to: CGPoint(x: 0, y: geo.size.height))
                    for (i, v) in values.enumerated() {
                        let x = CGFloat(i) * stepX
                        let normalized = (v - minV) / range
                        let y = geo.size.height - (CGFloat(normalized) * geo.size.height)
                        p.addLine(to: CGPoint(x: x, y: y))
                    }
                    p.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height))
                    p.closeSubpath()
                }
                .fill(LinearGradient(
                    colors: [Color.accentColor.opacity(0.35), Color.accentColor.opacity(0.02)],
                    startPoint: .top, endPoint: .bottom
                ))

                // Line
                Path { p in
                    guard !values.isEmpty else { return }
                    let stepX = geo.size.width / CGFloat(max(values.count - 1, 1))
                    for (i, v) in values.enumerated() {
                        let x = CGFloat(i) * stepX
                        let normalized = (v - minV) / range
                        let y = geo.size.height - (CGFloat(normalized) * geo.size.height)
                        if i == 0 {
                            p.move(to: CGPoint(x: x, y: y))
                        } else {
                            p.addLine(to: CGPoint(x: x, y: y))
                        }
                    }
                }
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

// MARK: - Bar trend chart

struct BarTrendChart: View {
    let points: [DailyPoint]
    var showAxis: Bool = false

    var body: some View {
        GeometryReader { geo in
            let values = points.map { Double($0.totalTokens) }
            let maxV = max(values.max() ?? 1, 1)
            let count = CGFloat(max(values.count, 1))
            let spacing: CGFloat = 2
            let barWidth = max((geo.size.width - spacing * (count - 1)) / count, 1)

            HStack(alignment: .bottom, spacing: spacing) {
                ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                    let h = max((CGFloat(v) / CGFloat(maxV)) * geo.size.height, 1)
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(LinearGradient(
                            colors: [Color.accentColor, Color.accentColor.opacity(0.55)],
                            startPoint: .top, endPoint: .bottom
                        ))
                        .frame(width: barWidth, height: h)
                }
            }
        }
    }
}

// MARK: - Heatmap grid

struct HeatmapGridView: View {
    let payload: HeatmapPayload
    /// Truncate to the most recent N weeks (helps small sizes).
    var maxWeeks: Int = 26

    var body: some View {
        GeometryReader { geo in
            let weeks = Array(payload.weeks.suffix(maxWeeks))
            let rows = 7
            let cols = max(weeks.count, 1)
            let spacing: CGFloat = 2
            let cell = min(
                (geo.size.width - spacing * CGFloat(cols - 1)) / CGFloat(cols),
                (geo.size.height - spacing * CGFloat(rows - 1)) / CGFloat(rows)
            )
            let totalW = cell * CGFloat(cols) + spacing * CGFloat(cols - 1)
            let totalH = cell * CGFloat(rows) + spacing * CGFloat(rows - 1)

            VStack(spacing: spacing) {
                ForEach(0..<rows, id: \.self) { row in
                    HStack(spacing: spacing) {
                        ForEach(0..<cols, id: \.self) { col in
                            let level = (col < weeks.count && row < weeks[col].count) ? weeks[col][row] : 0
                            RoundedRectangle(cornerRadius: max(cell * 0.18, 1))
                                .fill(WidgetTheme.heatmapLevels[max(0, min(4, level))])
                                .frame(width: cell, height: cell)
                        }
                    }
                }
            }
            .frame(width: totalW, height: totalH)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}

// MARK: - Limit row

struct LimitBarRow: View {
    let limit: LimitProvider

    var body: some View {
        let f = max(0, min(1, limit.fraction))
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Circle()
                    .fill(WidgetTheme.sourceColor(limit.source))
                    .frame(width: 6, height: 6)
                Text(limit.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(WidgetFormat.percent(f * 100, decimals: 0))
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(WidgetTheme.limitTrack)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(WidgetTheme.limitBarColor(f))
                        .frame(width: geo.size.width * f)
                }
            }
            .frame(height: 4)
        }
    }
}

// MARK: - Source dot row

struct SourceDot: View {
    let source: String
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(WidgetTheme.sourceColor(source))
                .frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(value)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }
}

// MARK: - Empty state

struct WidgetEmptyState: View {
    let message: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "bolt.slash")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Footer

struct WidgetFooter: View {
    let updated: Date
    var serverOnline: Bool = true

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(serverOnline ? Color.green : Color.orange)
                .frame(width: 5, height: 5)
            Text("Updated \(WidgetFormat.relativeUpdated(updated))")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }
}
