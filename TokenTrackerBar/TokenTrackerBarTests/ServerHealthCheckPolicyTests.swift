import XCTest

final class ServerHealthCheckPolicyTests: XCTestCase {
    func testOwnedServerUsesLowFrequencyHealthChecks() {
        XCTAssertEqual(
            ServerHealthCheckPolicy.interval(for: .ownedProcess),
            5 * 60
        )
    }

    func testExternalServerRetainsResponsiveHealthChecks() {
        XCTAssertEqual(
            ServerHealthCheckPolicy.interval(for: .externalProcess),
            30
        )
    }

    func testOwnedServerChecksAreAtLeastTenTimesLessFrequent() {
        XCTAssertGreaterThanOrEqual(
            ServerHealthCheckPolicy.ownedProcessInterval,
            ServerHealthCheckPolicy.externalProcessInterval * 10
        )
    }
}
