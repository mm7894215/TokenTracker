import SwiftUI
import AppKit

struct UsageLimitsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var settings = LimitsSettingsStore.shared
    @State private var showSettings = false
    let limits: UsageLimitsResponse?

    /// At least one provider is configured and error-free.
    private func hasAnyAvailable(_ limits: UsageLimitsResponse) -> Bool {
        let providers: [(Bool, String?)] = [
            (limits.claude.configured, limits.claude.error),
            (limits.codex.configured, limits.codex.error),
            (limits.cursor.configured, limits.cursor.error),
            (limits.gemini.configured, limits.gemini.error),
            (limits.kiro.configured, limits.kiro.error),
            (limits.antigravity.configured, limits.antigravity.error),
            (limits.copilot?.configured ?? false, limits.copilot?.error),
        ]
        return providers.contains { $0.0 && $0.1 == nil }
    }

    var body: some View {
        if let limits, hasAnyAvailable(limits) {
            let visibleGroups = buildVisibleGroups(limits)

            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: Strings.usageLimitsTitle) {
                    SettingsGearButton(isPresented: $showSettings) {
                        LimitsSettingsView(store: settings)
                    }
                }

                if visibleGroups.isEmpty {
                    // All hidden by user — show hint so they know gear exists
                    Text(Strings.allProvidersHidden)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                } else {
                    ForEach(Array(visibleGroups.enumerated()), id: \.offset) { index, group in
                        if index > 0 {
                            Divider()
                                .opacity(0.4)
                                .padding(.vertical, 2)
                        }
                        group
                    }
                }
            }
        } else if limits == nil {
            LimitsSkeleton()
        }
    }

    // MARK: - Visible Groups (respect settings order + visibility, hide errors)

    private func buildVisibleGroups(_ limits: UsageLimitsResponse) -> [AnyView] {
        var groups: [AnyView] = []

        for id in settings.providerOrder {
            guard settings.isVisible(id) else { continue }

            switch id {
            case "claude" where limits.claude.configured && limits.claude.error == nil:
                groups.append(AnyView(toolSection(title: "Claude", assetName: "ClaudeLogo") { claudeContent(limits.claude) }))
            case "codex" where limits.codex.configured && limits.codex.error == nil:
                groups.append(AnyView(toolSection(title: "Codex", assetName: "CodexLogo") { codexContent(limits.codex) }))
            case "cursor" where limits.cursor.configured && limits.cursor.error == nil:
                groups.append(AnyView(toolSection(title: "Cursor", assetName: "CursorLogo") { cursorContent(limits.cursor) }))
            case "gemini" where limits.gemini.configured && limits.gemini.error == nil:
                groups.append(AnyView(toolSection(title: "Gemini", assetName: "GeminiLogo") { geminiContent(limits.gemini) }))
            case "kiro" where limits.kiro.configured && limits.kiro.error == nil:
                groups.append(AnyView(toolSection(title: "Kiro", assetName: "KiroLogo") { kiroContent(limits.kiro) }))
            case "antigravity" where limits.antigravity.configured && limits.antigravity.error == nil:
                groups.append(AnyView(toolSection(title: "Antigravity", assetName: "AntigravityLogo") { antigravityContent(limits.antigravity) }))
            case "copilot":
                if let copilot = limits.copilot, copilot.configured, copilot.error == nil {
                    groups.append(AnyView(toolSection(title: "GitHub Copilot", assetName: "CopilotLogo") { copilotContent(copilot) }))
                }
            default:
                break
            }
        }
        return groups
    }

    // MARK: - Tool Section

    private func toolSection<Content: View>(
        title: String,
        assetName: String?,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                if let assetName {
                    brandIcon(assetName)
                        .frame(width: 14, height: 14)
                }
                Text(title)
                    .font(.system(.caption, design: .default))
                    .modifier(FontWeightModifier(weight: .medium))
            }
            content()
        }
    }

    // MARK: - Claude

    private func claudeContent(_ claude: ClaudeLimits) -> some View {
        VStack(spacing: 4) {
            if let w = claude.fiveHour {
                limitRow(label: "5h", pct: w.utilization, reset: relativeReset(iso: w.resetsAt), toolName: "Claude")
            }
            if let w = claude.sevenDay {
                limitRow(label: "7d", pct: w.utilization, reset: relativeReset(iso: w.resetsAt), toolName: "Claude")
            }
            if let w = claude.sevenDayOpus {
                limitRow(label: "Opus", pct: w.utilization, reset: relativeReset(iso: w.resetsAt), toolName: "Claude")
            }
        }
    }

    // MARK: - Codex

    private func codexContent(_ codex: CodexLimits) -> some View {
        VStack(spacing: 4) {
            if let w = codex.primaryWindow {
                limitRow(label: "5h", pct: Double(w.usedPercent), reset: relativeReset(epoch: w.resetAt), toolName: "Codex")
            }
            if let w = codex.secondaryWindow {
                limitRow(label: "7d", pct: Double(w.usedPercent), reset: relativeReset(epoch: w.resetAt), toolName: "Codex")
            }
        }
    }

    // MARK: - Cursor

    private func cursorContent(_ cursor: CursorLimits) -> some View {
        VStack(spacing: 4) {
            if let w = cursor.primaryWindow {
                limitRow(label: Strings.cursorPlanLabel, pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Cursor")
            }
            if let w = cursor.secondaryWindow {
                limitRow(label: Strings.cursorAutoLabel, pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Cursor")
            }
            if let w = cursor.tertiaryWindow {
                limitRow(label: "API", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Cursor")
            }
        }
    }

    // MARK: - Gemini

    private func geminiContent(_ gemini: GeminiLimits) -> some View {
        VStack(spacing: 4) {
            if let w = gemini.primaryWindow {
                limitRow(label: "Pro", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Gemini")
            }
            if let w = gemini.secondaryWindow {
                limitRow(label: "Flash", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Gemini")
            }
            if let w = gemini.tertiaryWindow {
                limitRow(label: "Lite", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Gemini")
            }
        }
    }

    // MARK: - Kiro

    private func kiroContent(_ kiro: KiroLimits) -> some View {
        VStack(spacing: 4) {
            if let w = kiro.primaryWindow {
                limitRow(label: Strings.kiroMonthLabel, pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Kiro")
            }
            if let w = kiro.secondaryWindow {
                limitRow(label: "Bonus", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Kiro")
            }
        }
    }

    // MARK: - Copilot

    private func copilotContent(_ copilot: CopilotLimits) -> some View {
        VStack(spacing: 4) {
            if let w = copilot.primaryWindow {
                limitRow(label: "Premium", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "GitHub Copilot")
            }
            if let w = copilot.secondaryWindow {
                limitRow(label: "Chat", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "GitHub Copilot")
            }
        }
    }

    // MARK: - Antigravity

    private func antigravityContent(_ antigravity: AntigravityLimits) -> some View {
        VStack(spacing: 4) {
            if let w = antigravity.primaryWindow {
                limitRow(label: "Claude", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Antigravity")
            }
            if let w = antigravity.secondaryWindow {
                limitRow(label: "G Pro", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Antigravity")
            }
            if let w = antigravity.tertiaryWindow {
                limitRow(label: "Flash", pct: w.usedPercent, reset: relativeReset(iso: w.resetAt), toolName: "Antigravity")
            }
        }
    }

    // MARK: - Row

    private func limitRow(label: String, pct: Double, reset: String?, toolName: String) -> some View {
        let clamped = min(max(pct, 0), 100)
        let fraction = clamped / 100.0
        let a11yParts = [
            "\(toolName) \(label) limit, \(Int(clamped.rounded()))%",
            reset.map { "resets in \($0)" }
        ].compactMap { $0 }

        return HStack(spacing: 5) {
            Text(label)
                .font(.system(.caption, design: .default))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.limitTrack)
                    if fraction > 0 {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.limitBar(fraction: fraction))
                            .frame(width: max(3, geo.size.width * min(fraction, 1.0)))
                    }
                }
            }
            .frame(height: 5)

            Text("\(Int(clamped.rounded()))%")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)

            if let reset {
                Text(reset)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.tertiary)
                    .frame(width: 24, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11yParts.joined(separator: ", "))
    }

    // MARK: - Helpers

    private func relativeReset(iso: String?) -> String? {
        guard let iso else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: iso) ?? {
            fmt.formatOptions = [.withInternetDateTime]
            return fmt.date(from: iso)
        }() else { return nil }
        return relativeString(from: date)
    }

    private func relativeReset(epoch: Int?) -> String? {
        guard let epoch else { return nil }
        return relativeString(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
    }

    private func relativeString(from date: Date) -> String {
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return "now" }
        let h = Int(s) / 3600
        if h > 24 { return "\(h / 24)d" }
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    @ViewBuilder
    private func brandIcon(_ name: String) -> some View {
        switch name {
        case "CursorLogo", "KiroLogo", "CopilotLogo":
            let filename: String = {
                switch name {
                case "CursorLogo": return "cursor.svg"
                case "KiroLogo": return "kiro.svg"
                default: return "copilot.svg"
                }
            }()
            if let image = bundledSVGIcon(
                named: filename,
                replacingCurrentColorWith: colorScheme == .dark ? "#FFFFFF" : "#111111"
            ) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            }
        default:
            Image(name)
                .renderingMode(.original)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
        }
    }

    private func bundledSVGIcon(named filename: String, replacingCurrentColorWith color: String? = nil) -> NSImage? {
        guard let url = Bundle.main.resourceURL?
            .appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\(filename)"),
              var svg = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }

        if let color {
            svg = svg.replacingOccurrences(of: "currentColor", with: color)
        }

        svg = normalizedIconSVG(svg, targetSize: 24)

        guard let data = svg.data(using: .utf8),
              let sourceImage = NSImage(data: data) else {
            return nil
        }

        sourceImage.size = NSSize(width: 24, height: 24)
        sourceImage.isTemplate = false
        return sourceImage
    }

    private func normalizedIconSVG(_ svg: String, targetSize: Int) -> String {
        var normalized = svg
        let widthPattern = #"width\s*=\s*"[^"]*""#
        let heightPattern = #"height\s*=\s*"[^"]*""#

        if normalized.range(of: widthPattern, options: .regularExpression) != nil {
            normalized = normalized.replacingOccurrences(
                of: widthPattern,
                with: #"width="\#(targetSize)""#,
                options: .regularExpression
            )
        } else {
            normalized = normalized.replacingOccurrences(
                of: "<svg",
                with: #"<svg width="\#(targetSize)""#,
                options: .literal,
                range: normalized.range(of: "<svg")
            )
        }

        if normalized.range(of: heightPattern, options: .regularExpression) != nil {
            normalized = normalized.replacingOccurrences(
                of: heightPattern,
                with: #"height="\#(targetSize)""#,
                options: .regularExpression
            )
        } else {
            normalized = normalized.replacingOccurrences(
                of: "<svg",
                with: #"<svg height="\#(targetSize)""#,
                options: .literal,
                range: normalized.range(of: "<svg")
            )
        }

        return normalized
    }
}

// MARK: - Settings Gear Button

private struct SettingsGearButton<Popover: View>: View {
    @Binding var isPresented: Bool
    @State private var isHovered = false
    @ViewBuilder let popover: () -> Popover

    var body: some View {
        Button(action: { isPresented.toggle() }) {
            Image(systemName: "gearshape")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isHovered || isPresented ? .secondary : .tertiary)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .popover(isPresented: $isPresented, arrowEdge: .trailing) {
            popover()
        }
    }
}

// MARK: - Skeleton Loading

private struct LimitsSkeleton: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: Strings.usageLimitsTitle)

            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        skeletonRect(width: 14, height: 14, radius: 3)
                        skeletonRect(width: 50, height: 10, radius: 3)
                    }
                    ForEach(0..<2, id: \.self) { _ in
                        HStack(spacing: 5) {
                            skeletonRect(width: 28, height: 8, radius: 2)
                            skeletonRect(height: 5, radius: 2)
                            skeletonRect(width: 28, height: 8, radius: 2)
                        }
                    }
                }
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func skeletonRect(width: CGFloat? = nil, height: CGFloat, radius: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: radius)
            .fill(Color.gray.opacity(phase > 0 ? 0.14 : 0.06))
            .frame(width: width, height: height)
    }
}
