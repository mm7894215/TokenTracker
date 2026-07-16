import Foundation

/// Which character (if any) animates as the menu bar icon.
enum MenuBarIconStyle: String, CaseIterable {
    case clawd
    case cat
    case pet
    case `static`

    static let defaultsKey = "MenuBarIconStyle"
    /// Legacy bool key from the pre-0.81 "Animated icon" toggle.
    static let legacyAnimationEnabledKey = "MenuBarAnimationEnabled"

    /// Reads the persisted style. Migrates the legacy animation toggle:
    /// users who had explicitly disabled animation keep a static icon.
    static func current(defaults: UserDefaults = .standard) -> MenuBarIconStyle {
        if let raw = defaults.string(forKey: defaultsKey),
           let style = MenuBarIconStyle(rawValue: raw) {
            return style
        }
        if defaults.object(forKey: legacyAnimationEnabledKey) as? Bool == false {
            return .static
        }
        return .clawd
    }

    static func setCurrent(_ style: MenuBarIconStyle, defaults: UserDefaults = .standard) {
        defaults.set(style.rawValue, forKey: defaultsKey)
    }
}

/// Motion tier for the runner icons (cat / pet). The animator maps its state
/// machine onto these tiers; the tables below are the single source of truth
/// for frame pacing so tests can pin the speed contract.
enum MenuBarRunnerMotion {
    case sleeping
    case idle
    case syncing
    case sprinting
}

enum MenuBarRunnerPace {
    /// Seconds per frame. The cat is RunCat-style: state is expressed through
    /// running speed (sleeping uses a dedicated curled-up pose instead).
    static func frameInterval(style: MenuBarIconStyle, motion: MenuBarRunnerMotion) -> TimeInterval {
        switch style {
        case .cat:
            switch motion {
            case .sleeping: return 1.2
            case .idle: return 0.5
            case .syncing: return 0.2
            case .sprinting: return 0.08
            }
        case .pet:
            switch motion {
            case .sleeping: return 0.6
            case .idle: return 0.4
            case .syncing: return 0.15
            case .sprinting: return 0.08
            }
        case .clawd, .static:
            return 0.15
        }
    }

    /// How long a queue-append activity burst keeps the runner sprinting.
    static let sprintWindow: TimeInterval = 30
}
