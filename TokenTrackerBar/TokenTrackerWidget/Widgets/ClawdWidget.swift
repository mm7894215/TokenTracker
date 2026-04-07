import SwiftUI
import WidgetKit

// Compact "Clawd companion" widget. Widgets are static (no animation
// budget) so we render a friendly pixel-art style frame and pick a "mood"
// based on the current usage relative to the 30-day average.

struct ClawdWidget: Widget {
    let kind: String = "TokenTrackerClawdWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticSnapshotProvider()) { entry in
            ClawdWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Clawd Companion")
        .description("Your TokenTracker mascot with today's usage at a glance.")
        .supportedFamilies([.systemSmall])
    }
}

struct ClawdWidgetView: View {
    let entry: StaticEntry

    private var mood: ClawdMood {
        let today = entry.snapshot.today.tokens
        let avg = max(entry.snapshot.last30d.activeDays, 1) > 0
            ? entry.snapshot.last30d.tokens / max(entry.snapshot.last30d.activeDays, 1)
            : 0
        guard avg > 0 else { return .idle }
        let ratio = Double(today) / Double(avg)
        if ratio < 0.25 { return .sleepy }
        if ratio < 0.75 { return .calm }
        if ratio < 1.5  { return .happy }
        return .excited
    }

    var body: some View {
        let snap = entry.snapshot
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("CLAWD")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.6)
                    .foregroundStyle(.tint)
                Spacer()
                Text(mood.label)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }

            ClawdPixelMascot(mood: mood)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 1) {
                Text("Today")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .tracking(0.4)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(WidgetFormat.compact(snap.today.tokens))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                    Text(WidgetFormat.cost(snap.today.costUsd))
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private enum ClawdMood {
    case sleepy, idle, calm, happy, excited

    var label: String {
        switch self {
        case .sleepy:  return "zzz"
        case .idle:    return "idle"
        case .calm:    return "calm"
        case .happy:   return "happy"
        case .excited: return "fired up"
        }
    }

    var bodyColor: Color {
        switch self {
        case .sleepy:  return Color(.sRGB, red: 0.55, green: 0.60, blue: 0.78, opacity: 1)
        case .idle:    return Color(.sRGB, red: 0.55, green: 0.65, blue: 0.85, opacity: 1)
        case .calm:    return Color(.sRGB, red: 0.45, green: 0.78, blue: 0.65, opacity: 1)
        case .happy:   return Color(.sRGB, red: 0.95, green: 0.78, blue: 0.30, opacity: 1)
        case .excited: return Color(.sRGB, red: 0.95, green: 0.45, blue: 0.40, opacity: 1)
        }
    }
}

// Tiny chunk-rendered pixel mascot. Renders a 9x9 grid as filled rounded
// squares — keeps the widget extension's drawing budget low and looks
// crisp at any widget scale.
private struct ClawdPixelMascot: View {

    let mood: ClawdMood

    // 9x9 grid. 0=empty, 1=body, 2=eye, 3=accent.
    private var grid: [[Int]] {
        switch mood {
        case .sleepy:
            return [
                [0,0,1,1,1,1,1,0,0],
                [0,1,1,1,1,1,1,1,0],
                [1,1,3,1,1,1,3,1,1],
                [1,1,1,1,1,1,1,1,1],
                [1,1,2,1,1,1,2,1,1], // closed eyes (rendered narrow)
                [1,1,1,1,1,1,1,1,1],
                [0,1,1,1,1,1,1,1,0],
                [0,0,1,1,1,1,1,0,0],
                [0,1,0,0,0,0,0,1,0]
            ]
        case .excited:
            return [
                [0,1,1,0,0,0,1,1,0],
                [1,1,1,1,1,1,1,1,1],
                [1,2,1,1,1,1,1,2,1],
                [1,1,1,1,1,1,1,1,1],
                [1,1,1,3,3,3,1,1,1],
                [1,1,1,1,1,1,1,1,1],
                [0,1,1,1,1,1,1,1,0],
                [0,0,1,1,1,1,1,0,0],
                [1,1,0,0,0,0,0,1,1]
            ]
        default:
            return [
                [0,0,1,1,1,1,1,0,0],
                [0,1,1,1,1,1,1,1,0],
                [1,1,1,1,1,1,1,1,1],
                [1,2,1,1,1,1,1,2,1],
                [1,1,1,1,1,1,1,1,1],
                [1,1,1,3,3,3,1,1,1],
                [0,1,1,1,1,1,1,1,0],
                [0,0,1,1,1,1,1,0,0],
                [0,1,0,0,0,0,0,1,0]
            ]
        }
    }

    var body: some View {
        GeometryReader { geo in
            let cols = 9
            let rows = 9
            let size = min(geo.size.width / CGFloat(cols), geo.size.height / CGFloat(rows))
            let totalW = size * CGFloat(cols)
            let totalH = size * CGFloat(rows)

            ZStack {
                VStack(spacing: 0) {
                    ForEach(0..<rows, id: \.self) { r in
                        HStack(spacing: 0) {
                            ForEach(0..<cols, id: \.self) { c in
                                let v = grid[r][c]
                                Rectangle()
                                    .fill(color(for: v))
                                    .frame(width: size, height: size)
                            }
                        }
                    }
                }
                .frame(width: totalW, height: totalH)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func color(for value: Int) -> Color {
        switch value {
        case 1: return mood.bodyColor
        case 2: return Color.black
        case 3: return mood.bodyColor.opacity(0.55)
        default: return Color.clear
        }
    }
}
