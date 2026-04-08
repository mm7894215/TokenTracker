import SwiftUI
import WidgetKit

// Rate-limit progress widget. The bars ARE the widget — sorted by remaining
// headroom (most-consumed first) so the most urgent provider is always at
// the top. Reset countdown sits beside the bar where space allows.

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

    private var maxRows: Int {
        family == .systemMedium ? 4 : 8
    }

    /// Sort providers so all windows from the same source stay adjacent
    /// (Claude · 7d next to Claude · 5h). Sources are ordered by their
    /// hottest window so the most-urgent provider floats to the top.
    /// Within a source, higher fraction comes first.
    private var orderedRows: [LimitProvider] {
        let grouped = Dictionary(grouping: entry.snapshot.limits, by: { $0.source })
        let orderedGroups = grouped.values.sorted { lhs, rhs in
            (lhs.map(\.fraction).max() ?? 0) > (rhs.map(\.fraction).max() ?? 0)
        }
        let flat = orderedGroups.flatMap { $0.sorted { $0.fraction > $1.fraction } }
        return Array(flat.prefix(maxRows))
    }

    var body: some View {
        let trimmed = orderedRows
        if trimmed.isEmpty {
            WidgetEmptyState(message: "No configured providers")
        } else {
            // Uniform spacing across all rows. The grouping (Claude windows
            // adjacent to each other) is communicated by the dot color and
            // shared "Claude · …" label — no extra gap needed. Vertical
            // centering via top/bottom Spacers; the inner VStack uses
            // fixedSize so it doesn't get stretched by the surrounding
            // GeometryReader inside LimitRow.
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: rowGap) {
                    ForEach(trimmed) { (limit: LimitProvider) in
                        LimitRow(limit: limit)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var rowGap: CGFloat { family == .systemMedium ? 9 : 12 }
}

private struct LimitRow: View {
    let limit: LimitProvider

    var body: some View {
        let f = max(0, min(1, limit.fraction))
        let reset = WidgetFormat.relativeReset(limit.resetsAt)
        let urgent = f >= 0.9
        let textColor: Color = urgent ? WidgetTheme.limitBarColor(f) : .primary

        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle()
                    .fill(WidgetTheme.sourceColor(limit.source))
                    .frame(width: 6, height: 6)
                Text(limit.label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(textColor)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let reset {
                    Text(reset)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Text(WidgetFormat.percent(f * 100, decimals: 0))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(textColor)
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(WidgetTheme.limitTrack)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(WidgetTheme.limitBarColor(f))
                        .frame(width: max(geo.size.width * f, f > 0 ? 4 : 0))
                }
            }
            .frame(height: 5)
        }
    }
}
