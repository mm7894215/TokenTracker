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
}
