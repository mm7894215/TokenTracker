import SwiftUI

/// Applies `.tracking()` on macOS 13+ and is a no-op on older versions.
struct TrackingModifier: ViewModifier {
    let value: CGFloat
    func body(content: Content) -> some View {
        if #available(macOS 13, *) {
            content.tracking(value)
        } else {
            content
        }
    }
}

/// Applies `.fontWeight()` on macOS 13+ and is a no-op on older versions.
struct FontWeightModifier: ViewModifier {
    let weight: Font.Weight
    func body(content: Content) -> some View {
        if #available(macOS 13, *) {
            content.fontWeight(weight)
        } else {
            content
        }
    }
}

/// Unified section header used across all dashboard sections.
struct SectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    init(title: String, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack {
            Text(title)
                .font(.caption)
                .modifier(FontWeightModifier(weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .modifier(TrackingModifier(value: 0.5))
            Spacer()
            trailing()
        }
    }
}

/// Rounded placeholder shown when a section has no data yet.
struct PlaceholderBlock: View {
    let height: CGFloat
    var hint: String = Strings.noData

    var body: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color.gray.opacity(0.06))
            .frame(height: height)
            .overlay(
                Text(hint)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
            )
    }
}
