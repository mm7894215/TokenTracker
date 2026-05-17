import SwiftUI

struct FooterView: View {
    @State private var hoveringDashboard = false
    @State private var hoveringQuit = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                DashboardWindowController.shared.showWindow()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "macwindow")
                    Text(Strings.openDashboard)
                }
                    .font(.caption)
                    .modifier(FontWeightModifier(weight: .medium))
                    .foregroundStyle(hoveringDashboard ? .primary : Color.accentColor)
                    .scaleEffect(hoveringDashboard ? 1.03 : 1.0)
                    .animation(.easeOut(duration: 0.12), value: hoveringDashboard)
            }
            .frame(minHeight: 28)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
            .onHover { hovering in
                hoveringDashboard = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            Spacer()

            Button {
                AppDelegate.requestQuit()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "power")
                    Text(Strings.quitButton)
                }
                    .font(.caption)
                    .foregroundStyle(hoveringQuit ? .primary : .secondary)
                    .scaleEffect(hoveringQuit ? 1.03 : 1.0)
                    .animation(.easeOut(duration: 0.12), value: hoveringQuit)
            }
            .frame(minHeight: 28)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
            .onHover { hovering in
                hoveringQuit = hovering
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 6)
    }
}
