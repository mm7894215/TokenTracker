import AppKit
import SwiftUI

/// Windows with large transparent, click-through regions conform so the cursor
/// coordinator only treats their interactive area as ours.
@MainActor
protocol CursorHitScoping: AnyObject {
    func containsInteractiveScreenPoint(_ screenPoint: NSPoint) -> Bool
}

/// Global pointer-cursor arbiter shared by every `pointingHandCursor()` site.
///
/// The Dynamic Island lives on a non-activating panel, so AppKit's automatic
/// cursor update can reset a cursor immediately after SwiftUI changes it.
@MainActor
final class PointerCursorCoordinator {
    static let shared = PointerCursorCoordinator()

    private var hovered = Set<UUID>()

    func update(_ token: UUID, hovering: Bool) {
        if hovering {
            hovered.insert(token)
            apply()
            return
        }
        hovered.remove(token)
        guard hovered.isEmpty else { return }
        if pointerInsideOurWindows() {
            NSCursor.arrow.set()
        }
    }

    func apply() {
        (hovered.isEmpty ? NSCursor.arrow : NSCursor.pointingHand).set()
    }

    /// Drop a claim without touching the cursor when a hovered control leaves
    /// the hierarchy before SwiftUI sends `onHover(false)`.
    func release(_ token: UUID) {
        hovered.remove(token)
    }

    private func pointerInsideOurWindows() -> Bool {
        let location = NSEvent.mouseLocation
        return NSApp.windows.contains { window in
            guard window.isVisible, window.frame.contains(location) else { return false }
            if let scoped = window as? CursorHitScoping {
                return scoped.containsInteractiveScreenPoint(location)
            }
            return true
        }
    }
}

private struct PointingHandCursorModifier: ViewModifier {
    @State private var token = UUID()

    func body(content: Content) -> some View {
        content
            .onHover { PointerCursorCoordinator.shared.update(token, hovering: $0) }
            .onDisappear { PointerCursorCoordinator.shared.release(token) }
    }
}

extension View {
    func pointingHandCursor() -> some View {
        modifier(PointingHandCursorModifier())
    }
}
