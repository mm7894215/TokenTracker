import XCTest

final class BackgroundRefreshPolicyTests: XCTestCase {
    func testRunsSyncWhenNoPreviousSyncExists() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: nil,
                syncInterval: 1_800
            ),
            true
        )
    }

    func testSkipsSyncInsideInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: Date(timeIntervalSince1970: 100),
                syncInterval: 1_800
            ),
            false
        )
    }

    func testRunsSyncAfterInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunSync(
                now: Date(timeIntervalSince1970: 2_000),
                lastSyncAt: Date(timeIntervalSince1970: 100),
                syncInterval: 1_800
            ),
            true
        )
    }

    func testRunsCatchUpSyncWhenNoPreviousSyncExists() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunCatchUpSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: nil,
                staleInterval: 300
            ),
            true
        )
    }

    func testSkipsCatchUpSyncWhenPreviousSyncIsFresh() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunCatchUpSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: Date(timeIntervalSince1970: 800),
                staleInterval: 300
            ),
            false
        )
    }

    func testRunsCatchUpSyncAtStaleBoundary() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunCatchUpSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: Date(timeIntervalSince1970: 700),
                staleInterval: 300
            ),
            true
        )
    }

    func testSkipsCatchUpSyncForNonPositiveInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunCatchUpSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: nil,
                staleInterval: 0
            ),
            false
        )
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunCatchUpSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastSyncAt: nil,
                staleInterval: -1
            ),
            false
        )
    }
}
