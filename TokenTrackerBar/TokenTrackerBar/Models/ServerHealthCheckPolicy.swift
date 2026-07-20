import Foundation

enum ServerHealthCheckPolicy {
    enum Ownership {
        case ownedProcess
        case externalProcess
    }

    static let ownedProcessInterval: TimeInterval = 5 * 60
    static let externalProcessInterval: TimeInterval = 30

    static func interval(for ownership: Ownership) -> TimeInterval {
        switch ownership {
        case .ownedProcess:
            return ownedProcessInterval
        case .externalProcess:
            return externalProcessInterval
        }
    }
}
