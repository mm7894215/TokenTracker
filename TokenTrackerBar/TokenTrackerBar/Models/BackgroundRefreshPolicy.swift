import Foundation

enum BackgroundRefreshPolicy {
    static let defaultRefreshInterval: TimeInterval = 300
    static let defaultSyncInterval: TimeInterval = 1_800

    static func shouldRunSync(
        now: Date,
        lastSyncAt: Date?,
        syncInterval: TimeInterval = defaultSyncInterval
    ) -> Bool {
        guard syncInterval > 0 else { return false }
        guard let lastSyncAt else { return true }
        return now.timeIntervalSince(lastSyncAt) >= syncInterval
    }
}
