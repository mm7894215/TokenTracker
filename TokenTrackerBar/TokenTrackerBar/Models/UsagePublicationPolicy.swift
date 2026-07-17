import Foundation

struct UsagePublicationSource: OptionSet, Equatable {
    let rawValue: Int

    static let localQueue = UsagePublicationSource(rawValue: 1 << 0)
    static let accountUpload = UsagePublicationSource(rawValue: 1 << 1)
}

enum UsageSummaryViewSource: Equatable {
    case localQueue
    case accountUpload
}

enum MenuBarSummarySlot: CaseIterable, Hashable {
    case today
    case rolling
    case total

    var selection: MenuBarSummarySelection {
        switch self {
        case .today: return .today
        case .rolling: return .rolling
        case .total: return .total
        }
    }
}

struct SummaryPublicationState {
    private var sourceBySlot: [MenuBarSummarySlot: UsageSummaryViewSource] = [:]
    private var accountReadCompletedAtBySlot: [MenuBarSummarySlot: Date] = [:]

    mutating func record(
        source: UsageSummaryViewSource,
        completedAt: Date,
        for summaries: MenuBarSummarySelection
    ) {
        for slot in MenuBarSummarySlot.allCases where summaries.contains(slot.selection) {
            sourceBySlot[slot] = source
            if source == .accountUpload {
                accountReadCompletedAtBySlot[slot] = completedAt
            } else {
                accountReadCompletedAtBySlot.removeValue(forKey: slot)
            }
        }
    }

    func source(for slot: MenuBarSummarySlot) -> UsageSummaryViewSource? {
        sourceBySlot[slot]
    }

    func latestAccountReadCompletion(
        for summaries: MenuBarSummarySelection
    ) -> Date? {
        MenuBarSummarySlot.allCases.compactMap { slot in
            guard summaries.contains(slot.selection),
                  sourceBySlot[slot] == .accountUpload else { return nil }
            return accountReadCompletedAtBySlot[slot]
        }.max()
    }
}

struct PendingUsagePublicationQueue {
    private(set) var sources = UsagePublicationSource()
    private(set) var summaries = MenuBarSummarySelection()

    var isEmpty: Bool { sources.isEmpty }

    mutating func enqueue(
        _ source: UsagePublicationSource,
        summaries nextSummaries: MenuBarSummarySelection
    ) {
        sources.formUnion(source)
        summaries.formUnion(nextSummaries)
    }

    mutating func removeAll() {
        sources = []
        summaries = []
    }

    mutating func takeIfReady(
        isLoading: Bool,
        syncInFlight: Bool,
        hiddenRefreshInFlight: Bool
    ) -> (sources: UsagePublicationSource, summaries: MenuBarSummarySelection)? {
        guard !isEmpty,
              !UsagePublicationPolicy.shouldQueueRefresh(
                isLoading: isLoading,
                syncInFlight: syncInFlight,
                hiddenRefreshInFlight: hiddenRefreshInFlight
              ) else { return nil }
        let result = (sources, summaries)
        removeAll()
        return result
    }
}

enum UsagePublicationPolicy {
    static func shouldQueueRefresh(
        isLoading: Bool,
        syncInFlight: Bool,
        hiddenRefreshInFlight: Bool
    ) -> Bool {
        isLoading || syncInFlight || hiddenRefreshInFlight
    }

    static func summariesToRefresh(
        state: SummaryPublicationState,
        sources: UsagePublicationSource,
        requested: MenuBarSummarySelection
    ) -> MenuBarSummarySelection {
        var result = MenuBarSummarySelection()
        for slot in MenuBarSummarySlot.allCases where requested.contains(slot.selection) {
            let shouldRefresh: Bool
            switch state.source(for: slot) {
            case .accountUpload:
                shouldRefresh = sources.contains(.accountUpload)
            case .localQueue:
                shouldRefresh = sources.contains(.localQueue)
            case nil:
                // Before the first successful summary read, either publication
                // is useful because it also establishes this slot's authority.
                shouldRefresh = !sources.isEmpty
            }
            if shouldRefresh {
                result.formUnion(slot.selection)
            }
        }
        return result
    }

    static func remainingAccountCacheDelay(
        state: SummaryPublicationState,
        summaries: MenuBarSummarySelection,
        now: Date,
        visibilityDelay: TimeInterval = BackgroundRefreshPolicy.defaultAccountUploadVisibilityDelay
    ) -> TimeInterval {
        remainingAccountCacheDelay(
            latestReadCompletedAt: state.latestAccountReadCompletion(for: summaries),
            now: now,
            visibilityDelay: visibilityDelay
        )
    }

    static func remainingAccountCacheDelay(
        latestReadCompletedAt: Date?,
        now: Date,
        visibilityDelay: TimeInterval = BackgroundRefreshPolicy.defaultAccountUploadVisibilityDelay
    ) -> TimeInterval {
        guard visibilityDelay > 0, let latestReadCompletedAt else {
            return 0
        }
        return max(
            0,
            latestReadCompletedAt.addingTimeInterval(visibilityDelay).timeIntervalSince(now)
        )
    }
}
