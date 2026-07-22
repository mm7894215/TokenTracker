import Foundation

enum ManualSyncRequestDisposition: Equatable {
    case start
    case queueAfterSilentSync
    case coalesceWithVisibleSync
}

enum SyncRequestPolicy {
    static func manualRequestDisposition(
        syncInFlight: Bool,
        isSyncing: Bool
    ) -> ManualSyncRequestDisposition {
        guard syncInFlight else { return .start }
        return isSyncing ? .coalesceWithVisibleSync : .queueAfterSilentSync
    }
}
