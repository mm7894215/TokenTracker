import XCTest

final class BackgroundRefreshPolicyTests: XCTestCase {
    func testAccountUploadVisibilityDelayCoversCloudReadModelLag() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.defaultAccountUploadVisibilityDelay,
            35
        )
        XCTAssertGreaterThan(
            BackgroundRefreshPolicy.defaultAccountUploadVisibilityDelay,
            30
        )
    }

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

    func testRunsPopoverOpenSyncWhenNoPreviousAttemptOrSyncExists() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastAttemptAt: nil,
                lastSyncAt: nil,
                syncInterval: 60
            ),
            true
        )
    }

    func testSkipsPopoverOpenSyncAfterRecentAttempt() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastAttemptAt: Date(timeIntervalSince1970: 950),
                lastSyncAt: nil,
                syncInterval: 60
            ),
            false
        )
    }

    func testSkipsPopoverOpenSyncAfterRecentSuccessfulSync() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastAttemptAt: nil,
                lastSyncAt: Date(timeIntervalSince1970: 950),
                syncInterval: 60
            ),
            false
        )
    }

    func testRunsPopoverOpenSyncAfterInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastAttemptAt: Date(timeIntervalSince1970: 939),
                lastSyncAt: Date(timeIntervalSince1970: 939),
                syncInterval: 60
            ),
            true
        )
    }

    func testSkipsPopoverOpenSyncForNonPositiveInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenSync(
                now: Date(timeIntervalSince1970: 1_000),
                lastAttemptAt: nil,
                lastSyncAt: nil,
                syncInterval: 0
            ),
            false
        )
    }

    func testRunsPopoverOpenLoadWhenNoPreviousRefreshExists() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenLoad(
                now: Date(timeIntervalSince1970: 1_000),
                lastRefreshedAt: nil,
                loadInterval: 30
            ),
            true
        )
    }

    func testSkipsPopoverOpenLoadWhenRecentlyRefreshed() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenLoad(
                now: Date(timeIntervalSince1970: 1_000),
                lastRefreshedAt: Date(timeIntervalSince1970: 980),
                loadInterval: 30
            ),
            false
        )
    }

    func testRunsPopoverOpenLoadAfterInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenLoad(
                now: Date(timeIntervalSince1970: 1_000),
                lastRefreshedAt: Date(timeIntervalSince1970: 970),
                loadInterval: 30
            ),
            true
        )
    }

    func testSkipsPopoverOpenLoadForNonPositiveInterval() {
        XCTAssertEqual(
            BackgroundRefreshPolicy.shouldRunPopoverOpenLoad(
                now: Date(timeIntervalSince1970: 1_000),
                lastRefreshedAt: nil,
                loadInterval: 0
            ),
            false
        )
    }
}
