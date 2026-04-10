import SwiftUI

struct PeriodPickerView: View {
    @Binding var selection: DateHelpers.Period
    let onChange: (DateHelpers.Period) -> Void

    var body: some View {
        HStack(spacing: 10) {
            ForEach(DateHelpers.Period.allCases) { period in
                Button {
                    onChange(period)
                } label: {
                    Text(period.label)
                        .font(.caption2)
                        .modifier(FontWeightModifier(weight: selection == period ? .semibold : .regular))
                        .foregroundStyle(selection == period ? .primary : .tertiary)
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
            }
        }
    }
}
