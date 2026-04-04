import SwiftUI
import AppKit

struct LimitsSettingsView: View {
    @ObservedObject var store: LimitsSettingsStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var draggingId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Limits Display")
                .font(.system(.headline, design: .default))
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)

            VStack(spacing: 0) {
                ForEach(store.providerOrder, id: \.self) { id in
                    providerRow(id: id)
                        .opacity(draggingId == id ? 0.4 : 1)
                        .onDrag {
                            draggingId = id
                            return NSItemProvider(object: id as NSString)
                        }
                        .onDrop(of: [.text], delegate: ReorderDropDelegate(
                            targetId: id,
                            store: store,
                            draggingId: $draggingId
                        ))
                }
            }
            .padding(.bottom, 6)
        }
        .frame(width: 240)
    }

    private func providerRow(id: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal")
                .font(.caption)
                .foregroundStyle(.tertiary)

            providerIcon(id: id)
                .frame(width: 14, height: 14)

            Text(LimitsSettingsStore.displayNames[id] ?? id)
                .font(.system(.body, design: .default))

            Spacer()

            Toggle("", isOn: Binding(
                get: { store.isVisible(id) },
                set: { store.providerVisibility[id] = $0 }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                NSCursor.openHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    // MARK: - Provider Icon (handles both asset catalog and bundled SVG)

    @ViewBuilder
    private func providerIcon(id: String) -> some View {
        switch id {
        case "cursor", "kiro":
            let filename = id == "cursor" ? "cursor.svg" : "kiro.svg"
            if let image = bundledSVGIcon(named: filename, color: colorScheme == .dark ? "#FFFFFF" : "#111111") {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Color.clear
            }
        default:
            if let iconName = LimitsSettingsStore.iconNames[id] {
                Image(iconName)
                    .renderingMode(.original)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
    }

    private func bundledSVGIcon(named filename: String, color: String) -> NSImage? {
        guard let url = Bundle.main.resourceURL?
            .appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\(filename)"),
              var svg = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        svg = svg.replacingOccurrences(of: "currentColor", with: color)

        // Normalize width/height to 24
        let widthPattern = #"width\s*=\s*"[^"]*""#
        let heightPattern = #"height\s*=\s*"[^"]*""#
        svg = svg.replacingOccurrences(of: widthPattern, with: #"width="24""#, options: .regularExpression)
        svg = svg.replacingOccurrences(of: heightPattern, with: #"height="24""#, options: .regularExpression)

        guard let data = svg.data(using: .utf8),
              let image = NSImage(data: data) else { return nil }
        image.size = NSSize(width: 24, height: 24)
        image.isTemplate = false
        return image
    }
}

// MARK: - Smooth Reorder via DropDelegate

private struct ReorderDropDelegate: DropDelegate {
    let targetId: String
    let store: LimitsSettingsStore
    @Binding var draggingId: String?

    func dropEntered(info: DropInfo) {
        guard let dragging = draggingId,
              dragging != targetId,
              let from = store.providerOrder.firstIndex(of: dragging),
              let to = store.providerOrder.firstIndex(of: targetId) else { return }

        withAnimation(.easeInOut(duration: 0.2)) {
            store.move(from: IndexSet(integer: from), to: to > from ? to + 1 : to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingId = nil
        return true
    }

    func dropExited(info: DropInfo) {}

    func validateDrop(info: DropInfo) -> Bool { true }
}
