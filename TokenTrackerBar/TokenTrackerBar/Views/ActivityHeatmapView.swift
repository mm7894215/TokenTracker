import SwiftUI

struct ActivityHeatmapView: View {
    let heatmap: HeatmapResponse?

    private let cellSize: CGFloat = 11
    private let spacing: CGFloat = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: Strings.activityTitle) {
                if let h = heatmap {
                    Text(Strings.activeDays(h.activeDays))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            if let h = heatmap, !h.weeks.isEmpty {
                // Use native SwiftUI views instead of Canvas for reliable rendering
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: spacing) {
                            ForEach(Array(h.weeks.enumerated()), id: \.offset) { idx, week in
                                VStack(spacing: spacing) {
                                    ForEach(0..<7, id: \.self) { dayIdx in
                                        let level = dayIdx < week.count ? (week[dayIdx]?.level ?? 0) : 0
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(colorForLevel(min(max(level, 0), 4)))
                                            .frame(width: cellSize, height: cellSize)
                                    }
                                }
                                .id(idx)
                            }
                        }
                    }
                    .onAppear {
                        proxy.scrollTo(h.weeks.count - 1, anchor: .trailing)
                    }
                }

                // Legend
                HStack(spacing: 4) {
                    Spacer()
                    Text(Strings.heatmapLegendLess)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                    ForEach(0..<5, id: \.self) { level in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(colorForLevel(level))
                            .frame(width: 8, height: 8)
                    }
                    Text(Strings.heatmapLegendMore)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            } else {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.gray.opacity(0.06))
                    .frame(height: 7 * (cellSize + spacing) - spacing)
            }
        }
    }

    private func colorForLevel(_ level: Int) -> Color {
        let clamped = min(max(level, 0), Color.heatmapLevels.count - 1)
        return Color.heatmapLevels[clamped]
    }
}
