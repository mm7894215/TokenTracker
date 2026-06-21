import SwiftUI
import AppKit

struct UsageLimitsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var settings = LimitsSettingsStore.shared
    @State private var showSettings = false
    /// Width of the widest visible row label; all label columns match it so
    /// bars align without reserving space for labels that aren't on screen.
    @State private var labelColumnWidth: CGFloat = 0
    /// Provider id whose explanation popover is open. Each provider block is
    /// clickable (CodexBar-style); clicking opens a side popover that explains how
    /// to read its bars. A click toggle — not hover — so nothing reflows/jitters.
    @State private var explainingProvider: String?
    let limits: UsageLimitsResponse?

    private static let rowColumnSpacing: CGFloat = 5
    private static let percentColumnWidth: CGFloat = 34
    private static let relativeResetColumnWidth: CGFloat = 24
    private static var resetExpiryColumnWidth: CGFloat {
        percentColumnWidth + rowColumnSpacing + relativeResetColumnWidth
    }

    /// At least one provider is configured and error-free.
    /// Delegates to the model helper (single source of truth for the predicate).
    private func hasAnyAvailable(_ limits: UsageLimitsResponse) -> Bool {
        limits.hasAnyProviderWithoutError
    }

    var body: some View {
        if let limits, hasAnyAvailable(limits) {
            let visibleGroups = buildVisibleGroups(limits)

            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "\(Strings.usageLimitsTitle) · \(displayModeTitle)") {
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
            .onPreferenceChange(LimitLabelWidthKey.self) { labelColumnWidth = ceil($0) }
        } else if limits == nil {
            LimitsSkeleton()
        }
    }

    // MARK: - Visible Groups (respect settings order + visibility, hide errors)

    /// Append the plan tier to the provider name when known, e.g. "Claude Max".
    private func planTitle(_ base: String, _ label: String?) -> String {
        label.map { "\(base) \($0)" } ?? base
    }

    private func buildVisibleGroups(_ limits: UsageLimitsResponse) -> [AnyView] {
        var groups: [AnyView] = []

        for id in settings.providerOrder {
            guard settings.isVisible(id) else { continue }

            switch id {
            case "claude" where limits.claude.configured && limits.claude.error == nil:
                groups.append(AnyView(toolSection(id: id, title: planTitle("Claude", limits.claude.planLabel), assetName: "ClaudeLogo", toolName: "Claude", specs: claudeSpecs(limits.claude))))
            case "codex" where limits.codex.configured && limits.codex.error == nil:
                let resetState = codexResetBankViewData(limits.codex.resetCredits)
                groups.append(AnyView(toolSection(id: id, title: planTitle("Codex", limits.codex.planLabel), assetName: "CodexLogo", toolName: "Codex", specs: codexSpecs(limits.codex), resetRows: resetState.rows, resetStatus: resetState.statusText)))
            case "cursor" where limits.cursor.configured && limits.cursor.error == nil:
                groups.append(AnyView(toolSection(id: id, title: planTitle("Cursor", limits.cursor.planLabel), assetName: "CursorLogo", toolName: "Cursor", specs: cursorSpecs(limits.cursor))))
            case "gemini" where limits.gemini.configured && limits.gemini.error == nil:
                groups.append(AnyView(toolSection(id: id, title: planTitle("Gemini", limits.gemini.planLabel), assetName: "GeminiLogo", toolName: "Gemini", specs: geminiSpecs(limits.gemini))))
            case "kimi":
                if let kimi = limits.kimi, kimi.configured, kimi.error == nil {
                    groups.append(AnyView(toolSection(id: id, title: planTitle("Kimi", kimi.planLabel), assetName: "KimiLogo", toolName: "Kimi", specs: kimiSpecs(kimi), footnote: kimi.parallelLimit.map { Strings.kimiParallelLabel($0) })))
                }
            case "kiro" where limits.kiro.configured && limits.kiro.error == nil:
                groups.append(AnyView(toolSection(id: id, title: planTitle("Kiro", limits.kiro.planLabel), assetName: "KiroLogo", toolName: "Kiro", specs: kiroSpecs(limits.kiro))))
            case "grok":
                if let grok = limits.grok, grok.configured, grok.error == nil {
                    groups.append(AnyView(toolSection(id: id, title: planTitle("Grok Build", grok.planLabel), assetName: "GrokLogo", toolName: "Grok Build", specs: grokSpecs(grok))))
                }
            case "antigravity" where limits.antigravity.configured && limits.antigravity.error == nil:
                groups.append(AnyView(toolSection(id: id, title: planTitle("Antigravity", limits.antigravity.planLabel), assetName: "AntigravityLogo", toolName: "Antigravity", specs: antigravitySpecs(limits.antigravity))))
            case "copilot":
                if let copilot = limits.copilot, copilot.configured, copilot.error == nil {
                    groups.append(AnyView(toolSection(id: id, title: planTitle("GitHub Copilot", copilot.planLabel), assetName: "CopilotLogo", toolName: "GitHub Copilot", specs: copilotSpecs(copilot))))
                }
            default:
                break
            }
        }
        return groups
    }

    // MARK: - Tool Section

    private func toolSection(
        id: String,
        title: String,
        assetName: String?,
        toolName: String,
        specs: [LimitWindowSpec],
        resetRows: [CodexResetRowSpec] = [],
        resetStatus: String? = nil,
        footnote: String? = nil
    ) -> some View {
        let isOpen = Binding(
            get: { explainingProvider == id },
            set: { explainingProvider = $0 ? id : nil }
        )
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                if let assetName {
                    brandIcon(assetName)
                        .frame(width: 14, height: 14)
                }
                Text(title)
                    .font(.system(.caption, design: .default))
                    .modifier(FontWeightModifier(weight: .medium))
            }
            VStack(spacing: 4) {
                ForEach(specs) { spec in
                    limitRow(label: spec.label, pct: spec.pct, reset: spec.resetText, toolName: toolName, windowSeconds: spec.windowSeconds, resetDate: spec.resetDate)
                }
            }
            if !resetRows.isEmpty || resetStatus != nil {
                resetSection(rows: resetRows, status: resetStatus)
            }
            if let footnote {
                Text(footnote)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.tertiary)
            }
        }
        .modifier(ProviderClickableStyle(isActive: explainingProvider == id))
        .onTapGesture { explainingProvider = (explainingProvider == id) ? nil : id }
        .popover(isPresented: isOpen, arrowEdge: .trailing) {
            LimitsExplainContent(providerName: title, specs: specs, remainingMode: settings.displayMode == .remaining)
        }
    }

    // MARK: - Window specs (one source of truth for rows + the explain popover)

    private func makeSpec(_ label: String, _ pct: Double, windowSeconds: Double? = nil, iso: String?) -> LimitWindowSpec {
        let date = resetDate(iso: iso)
        return LimitWindowSpec(label: label, pct: pct, windowSeconds: windowSeconds, resetDate: date, resetText: date.map(relativeString))
    }

    private func makeSpec(_ label: String, _ pct: Double, windowSeconds: Double? = nil, epoch: Int?) -> LimitWindowSpec {
        let date = resetDate(epoch: epoch)
        return LimitWindowSpec(label: label, pct: pct, windowSeconds: windowSeconds, resetDate: date, resetText: date.map(relativeString))
    }

    private func claudeSpecs(_ c: ClaudeLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.fiveHour { s.append(makeSpec("5h", w.utilization, windowSeconds: 5 * 3600, iso: w.resetsAt)) }
        if let w = c.sevenDay { s.append(makeSpec("7d", w.utilization, windowSeconds: 7 * 86400, iso: w.resetsAt)) }
        if let w = c.sevenDayOpus { s.append(makeSpec("Opus", w.utilization, windowSeconds: 7 * 86400, iso: w.resetsAt)) }
        return s
    }

    private func codexSpecs(_ c: CodexLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec("5h", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec("7d", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.sparkPrimaryWindow { s.append(makeSpec("Spark 5h", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        if let w = c.sparkSecondaryWindow { s.append(makeSpec("Spark 7d", Double(w.usedPercent), windowSeconds: w.limitWindowSeconds.map(Double.init), epoch: w.resetAt)) }
        return s
    }

    private func codexResetBankViewData(_ resetCredits: CodexLimits.ResetCredits?) -> (rows: [CodexResetRowSpec], statusText: String?) {
        let rows = codexResetRows(resetCredits)
        if !rows.isEmpty {
            return (rows, nil)
        }
        return ([], Strings.codexResetBankPassiveStatus(resetCredits))
    }

    private func codexResetRows(_ resetCredits: CodexLimits.ResetCredits?) -> [CodexResetRowSpec] {
        guard let resetCredits, resetCredits.availableCount != 0 else { return [] }

        return resetCredits.credits
            .filter { $0.status == "available" }
            .enumerated()
            .compactMap { index, credit in
                guard let expiresAt = resetDate(iso: credit.expiresAt) else { return nil }
                let label = Strings.codexResetBankLabel(index + 1)
                let expiry = Strings.codexResetBankExpiryDateTime(expiresAt)
                return CodexResetRowSpec(
                    label: label,
                    expiry: expiry,
                    lifetimeRemainingPercent: resetLifetimeRemainingPercent(
                        grantedAt: resetDate(iso: credit.grantedAt),
                        expiresAt: expiresAt
                    ),
                    accessibilityLabel: Strings.resetCreditAccessibility(label: label, expiry: expiry)
                )
            }
    }

    private func cursorSpecs(_ c: CursorLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec(Strings.cursorPlanLabel, w.usedPercent, iso: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec(Strings.cursorAutoLabel, w.usedPercent, iso: w.resetAt)) }
        if let w = c.tertiaryWindow { s.append(makeSpec("API", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func geminiSpecs(_ g: GeminiLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = g.primaryWindow { s.append(makeSpec("Pro", w.usedPercent, iso: w.resetAt)) }
        if let w = g.secondaryWindow { s.append(makeSpec("Flash", w.usedPercent, iso: w.resetAt)) }
        if let w = g.tertiaryWindow { s.append(makeSpec("Lite", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func kimiSpecs(_ k: KimiLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = k.primaryWindow { s.append(makeSpec(Strings.kimiWeeklyLabel, w.usedPercent, windowSeconds: 7 * 86400, iso: w.resetAt)) }
        if let w = k.secondaryWindow { s.append(makeSpec(Strings.kimiFiveHourLabel, w.usedPercent, windowSeconds: 5 * 3600, iso: w.resetAt)) }
        if let w = k.tertiaryWindow { s.append(makeSpec(Strings.kimiTotalLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func kiroSpecs(_ k: KiroLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = k.primaryWindow { s.append(makeSpec(Strings.kiroMonthLabel, w.usedPercent, iso: w.resetAt)) }
        if let w = k.secondaryWindow { s.append(makeSpec(Strings.kiroBonusLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func grokSpecs(_ g: GrokLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = g.primaryWindow { s.append(makeSpec(Strings.grokMonthLabel, w.usedPercent, iso: w.resetAt)) }
        if let w = g.secondaryWindow { s.append(makeSpec(Strings.grokOndemandLabel, w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func copilotSpecs(_ c: CopilotLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = c.primaryWindow { s.append(makeSpec("Premium", w.usedPercent, iso: w.resetAt)) }
        if let w = c.secondaryWindow { s.append(makeSpec("Chat", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    private func antigravitySpecs(_ a: AntigravityLimits) -> [LimitWindowSpec] {
        var s: [LimitWindowSpec] = []
        if let w = a.primaryWindow { s.append(makeSpec("Claude", w.usedPercent, iso: w.resetAt)) }
        if let w = a.secondaryWindow { s.append(makeSpec("G Pro", w.usedPercent, iso: w.resetAt)) }
        if let w = a.tertiaryWindow { s.append(makeSpec("Flash", w.usedPercent, iso: w.resetAt)) }
        return s
    }

    // MARK: - Row

    private func limitRow(
        label: String,
        pct: Double,
        reset: String?,
        toolName: String,
        windowSeconds: Double? = nil,
        resetDate: Date? = nil
    ) -> some View {
        let rawClamped = min(max(pct, 0), 100)
        let usedFraction = rawClamped / 100.0
        let displayValue = settings.displayMode == .remaining ? (100 - rawClamped) : rawClamped

        // Unified threshold fill (green → amber → red), based on actual usage so
        // the color reads the same in used and remaining modes.
        let fillColor = Color.limitBar(fraction: usedFraction)

        // Time-aware pace mark (CodexBar-style notch). Shown once the window has
        // meaningful usage (≥5%) so a fresh window doesn't float a mark in empty
        // track. Green when on/under pace, red when ahead (deficit). Requires a
        // trusted window length; monthly / billing-cycle windows show no mark.
        var pacePercent: Double?
        var paceOver = false
        if let windowSeconds, windowSeconds > 0, let resetDate {
            let pace = LimitPace.compute(
                usedFraction: usedFraction,
                windowSeconds: windowSeconds,
                secondsUntilReset: max(0, resetDate.timeIntervalSinceNow),
                remainingMode: settings.displayMode == .remaining
            )
            pacePercent = pace.pacePercent
            paceOver = pace.paceOver
        }

        let accessibilityLabel = Strings.limitAccessibility(
            toolName: toolName,
            label: label,
            percent: Int(displayValue.rounded()),
            reset: reset,
            modeSuffix: settings.displayMode == .remaining ? Strings.limitSuffixRemaining : Strings.limitSuffixUsed
        )

        return HStack(spacing: Self.rowColumnSpacing) {
            Text(label)
                .font(.system(.caption, design: .default))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .background(GeometryReader { proxy in
                    Color.clear.preference(key: LimitLabelWidthKey.self, value: proxy.size.width)
                })
                .frame(width: labelColumnWidth > 0 ? labelColumnWidth : nil, alignment: .leading)

            UsageLimitBar(
                percent: displayValue,
                fillColor: fillColor,
                pacePercent: pacePercent,
                paceOver: paceOver
            )

            Text(displayPercentLabel(displayValue))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: Self.percentColumnWidth, alignment: .trailing)

            if let reset {
                Text(reset)
                    .font(.system(.caption2, design: .default))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .frame(width: Self.relativeResetColumnWidth, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func resetSection(rows: [CodexResetRowSpec], status: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Strings.codexResetBankSectionTitle)
                .font(.system(.caption2, design: .default))
                .modifier(FontWeightModifier(weight: .medium))
                .foregroundStyle(.tertiary)

            if rows.isEmpty, let status {
                Text(status)
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.tertiary)
            } else {
                VStack(spacing: 4) {
                    ForEach(rows) { row in
                        resetRow(row)
                    }
                }
            }
        }
        .padding(.top, 1)
    }

    private func resetRow(_ row: CodexResetRowSpec) -> some View {
        HStack(spacing: Self.rowColumnSpacing) {
            Text(row.label)
                .font(.system(.caption, design: .default))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .background(GeometryReader { proxy in
                    Color.clear.preference(key: LimitLabelWidthKey.self, value: proxy.size.width)
                })
                .frame(width: labelColumnWidth > 0 ? labelColumnWidth : nil, alignment: .leading)

            UsageLimitBar(
                percent: row.lifetimeRemainingPercent,
                fillColor: Color.limitBar(fraction: 0),
                pacePercent: nil,
                paceOver: false
            )

            Text(row.expiry)
                .font(.system(.caption2, design: .default))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: Self.resetExpiryColumnWidth, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
    }

    private var displayModeTitle: String {
        settings.displayMode == .remaining ? Strings.limitDisplayModeRemaining : Strings.limitDisplayModeUsed
    }

    private func displayPercentLabel(_ value: Double) -> String {
        let rounded = Int(value.rounded())
        return "\(rounded)%"
    }

    // MARK: - Helpers

    private func relativeReset(iso: String?) -> String? {
        resetDate(iso: iso).map(relativeString)
    }

    private func relativeReset(epoch: Int?) -> String? {
        resetDate(epoch: epoch).map(relativeString)
    }

    /// Parsed reset instant — feeds both the relative label and the pace marker.
    private func resetDate(iso: String?) -> Date? {
        guard let iso else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fmt.date(from: iso) { return date }
        fmt.formatOptions = [.withInternetDateTime]
        if let date = fmt.date(from: iso) { return date }

        let microseconds = DateFormatter()
        microseconds.locale = Locale(identifier: "en_US_POSIX")
        microseconds.timeZone = TimeZone(secondsFromGMT: 0)
        microseconds.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX"
        return microseconds.date(from: iso)
    }

    private func resetDate(epoch: Int?) -> Date? {
        guard let epoch else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(epoch))
    }

    private func relativeString(from date: Date) -> String {
        let s = date.timeIntervalSince(Date())
        guard s > 0 else { return Strings.limitResetNow }
        let h = Int(s) / 3600
        if h > 24 { return "\(h / 24)d" }
        if h > 0 { return "\(h)h" }
        return "\(Int(s) / 60)m"
    }

    private func resetLifetimeRemainingPercent(grantedAt: Date?, expiresAt: Date) -> Double {
        guard let grantedAt else { return 100 }
        let total = expiresAt.timeIntervalSince(grantedAt)
        guard total > 0 else { return 100 }
        let remaining = expiresAt.timeIntervalSince(Date())
        return min(100, max(0, remaining / total * 100))
    }

    @ViewBuilder
    private func brandIcon(_ name: String) -> some View {
        switch name {
        case "CursorLogo", "KimiLogo", "KiroLogo", "GrokLogo", "CopilotLogo":
            let filename: String = {
                switch name {
                case "CursorLogo": return "cursor.svg"
                case "KimiLogo": return "kimi.svg"
                case "KiroLogo": return "kiro.svg"
                case "GrokLogo": return "grok.svg"
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

/// Reports the widest limit-row label so every row's label column can match it.
private struct LimitLabelWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct CodexResetRowSpec: Identifiable {
    var id: String { label }
    let label: String
    let expiry: String
    let lifetimeRemainingPercent: Double
    let accessibilityLabel: String
}

/// Makes a provider block read as clickable: a rounded hover/active highlight and
/// a pointing-hand cursor. `isActive` keeps the highlight while its popover is open.
private struct ProviderClickableStyle: ViewModifier {
    let isActive: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.primary.opacity(isActive ? 0.08 : (hovering ? 0.05 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .onHover { hovering in
                self.hovering = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
    }
}

/// One usage window's data — the single source of truth for both the rendered
/// row and the explanation popover, so the two never drift.
private struct LimitWindowSpec: Identifiable {
    var id: String { label }
    let label: String
    let pct: Double
    let windowSeconds: Double?
    let resetDate: Date?
    let resetText: String?
}

/// Side popover with this provider's live per-window numbers (used %, even-pace %,
/// ahead/on-track, reset) plus a short note on how to read the bars.
private struct LimitsExplainContent: View {
    let providerName: String
    let specs: [LimitWindowSpec]
    let remainingMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(providerName)
                .font(.system(.subheadline, design: .default).weight(.semibold))

            VStack(alignment: .leading, spacing: 6) {
                ForEach(specs) { spec in
                    Text(line(for: spec))
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Divider().opacity(0.5)

            Text(Strings.limitsExplainBody(remaining: remainingMode))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(width: 256)
    }

    /// Live pace numbers + current-rate projection for one window, via the shared
    /// `LimitPace.compute` (same source of truth the bar uses).
    private func line(for spec: LimitWindowSpec) -> String {
        let usedFraction = min(max(spec.pct, 0), 100) / 100.0
        let used = Int((usedFraction * 100).rounded())
        var pace = LimitPace.Result()
        if let windowSeconds = spec.windowSeconds, windowSeconds > 0, let resetDate = spec.resetDate {
            pace = LimitPace.compute(
                usedFraction: usedFraction,
                windowSeconds: windowSeconds,
                secondsUntilReset: max(0, resetDate.timeIntervalSinceNow),
                remainingMode: remainingMode
            )
        }
        return Strings.limitWindowExplainLine(
            label: spec.label, used: used, expected: pace.expectedPercent, over: pace.paceOver,
            runsOutEta: pace.runsOutEta, projectedEnd: pace.projectedEnd, remainingMode: remainingMode
        )
    }
}
