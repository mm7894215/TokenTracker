import CoreGraphics

/// Pure layout policy shared by the Dynamic Island controller and view.
///
/// Keeping the screen-height math outside AppKit makes the low-resolution and
/// Dock-reserved cases deterministic and unit-testable.
enum DynamicIslandLayoutPolicy {
    static let expandedWidth: CGFloat = 480
    static let shadowBleed: CGFloat = 28
    static let maximumIslandHeight: CGFloat = 800
    static let fixedChromeHeight: CGFloat = 240
    static let minimumLimitsHeight: CGFloat = 96

    static var maximumPanelHeight: CGFloat {
        maximumIslandHeight + shadowBleed
    }

    /// Fits the panel between the physical top edge and the bottom of the
    /// usable desktop (above a visible Dock), while preserving a viable minimum
    /// on unusual display configurations.
    static func panelHeight(screenTop: CGFloat, visibleBottom: CGFloat) -> CGFloat {
        let available = max(0, screenTop - visibleBottom)
        return min(maximumPanelHeight, max(available, minimumLimitsHeight + fixedChromeHeight + shadowBleed))
    }

    /// The provider list consumes whatever vertical room remains after the
    /// header, summary cards, divider, footer, and shadow bleed.
    static func limitsHeight(panelHeight: CGFloat) -> CGFloat {
        max(minimumLimitsHeight, panelHeight - shadowBleed - fixedChromeHeight)
    }
}

/// Pure interaction gate for hover events emitted by the fixed-size hosting
/// view. SwiftUI tracking areas can briefly retain their expanded geometry
/// while the island spring is collapsing, so visual hover alone is not enough:
/// the pointer must also be inside the controller's current black-shape rect.
enum DynamicIslandInteractionPolicy {
    static func shouldExpand(
        hovering: Bool,
        pointerInsideInteractiveRegion: Bool
    ) -> Bool {
        hovering && pointerInsideInteractiveRegion
    }
}

/// Timing and geometry for the island's centered visibility mask.
enum DynamicIslandVisibilityPolicy {
    static let showDuration: Double = 0.28
    static let hideDuration: Double = 0.28
    /// Lets SwiftUI commit the hidden frame before the panel leaves.
    static let hideSettleDelay: Double = 0.05
    static var hideCompletionDelay: Double { hideDuration + hideSettleDelay }
    static let centerPointWidth: CGFloat = 1

    static func revealWidth(
        progress: CGFloat,
        fullWidth: CGFloat,
        centerGapWidth: CGFloat,
        hasNotch: Bool,
        isDismissing: Bool = false
    ) -> CGFloat {
        let full = max(0, fullWidth)
        // The close endpoint must clear the notch's rounded lower corners.
        let hiddenWidth = hasNotch && !isDismissing
            ? max(0, centerGapWidth)
            : centerPointWidth
        let start = min(full, hiddenWidth)
        let clampedProgress = min(1, max(0, progress))
        return start + (full - start) * clampedProgress
    }
}

/// Rejects stale delayed completions after rapid toggles.
struct DynamicIslandVisibilityTransitionTracker {
    private(set) var current = 0

    mutating func begin() -> Int {
        current &+= 1
        return current
    }

    func owns(_ transition: Int) -> Bool {
        transition == current
    }
}
