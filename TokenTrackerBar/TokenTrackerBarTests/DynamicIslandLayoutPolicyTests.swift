import XCTest

final class DynamicIslandLayoutPolicyTests: XCTestCase {
    func testLargeDisplayUsesMaximumPanelHeight() {
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.panelHeight(screenTop: 1_080, visibleBottom: 0),
            DynamicIslandLayoutPolicy.maximumPanelHeight
        )
    }

    func testShortDisplayKeepsPanelAboveVisibleDock() {
        let height = DynamicIslandLayoutPolicy.panelHeight(screenTop: 720, visibleBottom: 40)

        XCTAssertEqual(height, 680)
        XCTAssertLessThanOrEqual(height, 720 - 40)
    }

    func testLimitsListShrinksWithPanelButKeepsUsableMinimum() {
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.limitsHeight(panelHeight: 680),
            412
        )
        XCTAssertEqual(
            DynamicIslandLayoutPolicy.limitsHeight(panelHeight: 200),
            DynamicIslandLayoutPolicy.minimumLimitsHeight
        )
    }

    func testHoverEnterRequiresPointerInsideCurrentInteractiveRegion() {
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: true,
                pointerInsideInteractiveRegion: false
            )
        )
        XCTAssertTrue(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: true,
                pointerInsideInteractiveRegion: true
            )
        )
        XCTAssertFalse(
            DynamicIslandInteractionPolicy.shouldExpand(
                hovering: false,
                pointerInsideInteractiveRegion: true
            )
        )
    }

    func testNotchedRevealStartsBehindHardwareNotchAndExpandsSymmetrically() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            120
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0.5,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            220
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 1,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true
            ),
            320
        )
    }

    func testSimulatedRevealStartsAtCenterWithoutStretchingPastBounds() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: -1,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 2,
                fullWidth: 160,
                centerGapWidth: 28,
                hasNotch: false
            ),
            160
        )
    }

    func testNotchedDismissalFinishesFullyBehindHardwareNotch() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 0,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true,
                isDismissing: true
            ),
            DynamicIslandVisibilityPolicy.centerPointWidth
        )
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.revealWidth(
                progress: 1,
                fullWidth: 320,
                centerGapWidth: 120,
                hasNotch: true,
                isDismissing: true
            ),
            320
        )
    }

    func testHideCompletionIncludesCompositorSettleDelay() {
        XCTAssertEqual(
            DynamicIslandVisibilityPolicy.hideCompletionDelay,
            DynamicIslandVisibilityPolicy.hideDuration + DynamicIslandVisibilityPolicy.hideSettleDelay
        )
    }

    func testLatestVisibilityTransitionOwnsDelayedCompletion() {
        var tracker = DynamicIslandVisibilityTransitionTracker()
        let opening = tracker.begin()
        let closing = tracker.begin()
        let reopening = tracker.begin()

        XCTAssertFalse(tracker.owns(opening))
        XCTAssertFalse(tracker.owns(closing))
        XCTAssertTrue(tracker.owns(reopening))
    }
}
