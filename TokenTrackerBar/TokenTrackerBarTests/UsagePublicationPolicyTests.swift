import XCTest

final class UsagePublicationPolicyTests: XCTestCase {

    func testRefreshQueuesBehindAnyOwningLoadOrSync() {
        XCTAssertFalse(
            UsagePublicationPolicy.shouldQueueRefresh(
                isLoading: false,
                syncInFlight: false,
                hiddenRefreshInFlight: false
            )
        )
        XCTAssertTrue(
            UsagePublicationPolicy.shouldQueueRefresh(
                isLoading: true,
                syncInFlight: false,
                hiddenRefreshInFlight: false
            )
        )
        XCTAssertTrue(
            UsagePublicationPolicy.shouldQueueRefresh(
                isLoading: false,
                syncInFlight: true,
                hiddenRefreshInFlight: false
            )
        )
        XCTAssertTrue(
            UsagePublicationPolicy.shouldQueueRefresh(
                isLoading: false,
                syncInFlight: false,
                hiddenRefreshInFlight: true
            )
        )
    }

    func testPendingPublicationsRemainQueuedUntilEveryOwnerFinishes() {
        var queue = PendingUsagePublicationQueue()
        queue.enqueue(.localQueue, summaries: [.today, .rolling])
        queue.enqueue(.accountUpload, summaries: .total)

        XCTAssertNil(
            queue.takeIfReady(
                isLoading: false,
                syncInFlight: true,
                hiddenRefreshInFlight: false
            )
        )
        XCTAssertFalse(queue.isEmpty)
        XCTAssertEqual(queue.sources, [.localQueue, .accountUpload])
        XCTAssertEqual(queue.summaries, .all)

        XCTAssertNil(
            queue.takeIfReady(
                isLoading: false,
                syncInFlight: false,
                hiddenRefreshInFlight: true
            )
        )
        XCTAssertFalse(queue.isEmpty)

        let pending = queue.takeIfReady(
            isLoading: false,
            syncInFlight: false,
            hiddenRefreshInFlight: false
        )
        XCTAssertEqual(pending?.sources, [.localQueue, .accountUpload])
        XCTAssertEqual(pending?.summaries, .all)
        XCTAssertTrue(queue.isEmpty)
    }

    func testPendingPublicationResetClearsSourcesAndSummarySelectionTogether() {
        var queue = PendingUsagePublicationQueue()
        queue.enqueue(.localQueue, summaries: .today)
        queue.removeAll()

        XCTAssertTrue(queue.isEmpty)
        XCTAssertTrue(queue.sources.isEmpty)
        XCTAssertTrue(queue.summaries.isEmpty)
    }

    func testUnknownSlotsRefreshFromFirstPublication() {
        let state = SummaryPublicationState()

        XCTAssertEqual(
            UsagePublicationPolicy.summariesToRefresh(
                state: state,
                sources: .localQueue,
                requested: [.today, .total]
            ),
            [.today, .total]
        )
        XCTAssertEqual(
            UsagePublicationPolicy.summariesToRefresh(
                state: state,
                sources: .accountUpload,
                requested: .rolling
            ),
            .rolling
        )
    }

    func testMixedSummarySourcesRouteIndependently() {
        var state = SummaryPublicationState()
        state.record(
            source: .accountUpload,
            completedAt: Date(timeIntervalSince1970: 100),
            for: [.today, .rolling]
        )
        state.record(
            source: .localQueue,
            completedAt: Date(timeIntervalSince1970: 101),
            for: .total
        )

        XCTAssertEqual(
            UsagePublicationPolicy.summariesToRefresh(
                state: state,
                sources: .accountUpload,
                requested: .all
            ),
            [.today, .rolling]
        )
        XCTAssertEqual(
            UsagePublicationPolicy.summariesToRefresh(
                state: state,
                sources: .localQueue,
                requested: .all
            ),
            .total
        )
    }

    func testCoalescedPublicationsRefreshEveryKnownSource() {
        var state = SummaryPublicationState()
        state.record(
            source: .accountUpload,
            completedAt: Date(timeIntervalSince1970: 100),
            for: .today
        )
        state.record(
            source: .localQueue,
            completedAt: Date(timeIntervalSince1970: 101),
            for: [.rolling, .total]
        )

        XCTAssertEqual(
            UsagePublicationPolicy.summariesToRefresh(
                state: state,
                sources: [.localQueue, .accountUpload],
                requested: .all
            ),
            .all
        )
    }

    func testLocalFallbackClearsAccountReadTimestamp() {
        var state = SummaryPublicationState()
        state.record(
            source: .accountUpload,
            completedAt: Date(timeIntervalSince1970: 100),
            for: .today
        )
        state.record(
            source: .localQueue,
            completedAt: Date(timeIntervalSince1970: 110),
            for: .today
        )

        XCTAssertEqual(state.source(for: .today), .localQueue)
        XCTAssertNil(state.latestAccountReadCompletion(for: .today))
    }

    func testCacheDelayUsesLatestRelevantAccountRead() {
        var state = SummaryPublicationState()
        state.record(
            source: .accountUpload,
            completedAt: Date(timeIntervalSince1970: 100),
            for: .today
        )
        state.record(
            source: .accountUpload,
            completedAt: Date(timeIntervalSince1970: 110),
            for: .total
        )

        XCTAssertEqual(
            UsagePublicationPolicy.remainingAccountCacheDelay(
                state: state,
                summaries: .all,
                now: Date(timeIntervalSince1970: 120),
                visibilityDelay: 35
            ),
            25
        )
        XCTAssertEqual(
            UsagePublicationPolicy.remainingAccountCacheDelay(
                state: state,
                summaries: .today,
                now: Date(timeIntervalSince1970: 120),
                visibilityDelay: 35
            ),
            15
        )
    }

    func testExpiredOrMissingAccountReadNeedsNoDelay() {
        XCTAssertEqual(
            UsagePublicationPolicy.remainingAccountCacheDelay(
                latestReadCompletedAt: nil,
                now: Date(timeIntervalSince1970: 200),
                visibilityDelay: 35
            ),
            0
        )
        XCTAssertEqual(
            UsagePublicationPolicy.remainingAccountCacheDelay(
                latestReadCompletedAt: Date(timeIntervalSince1970: 100),
                now: Date(timeIntervalSince1970: 200),
                visibilityDelay: 35
            ),
            0
        )
    }
}
