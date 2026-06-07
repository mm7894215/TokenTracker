import Foundation
import Combine

/// How the Usage Limits panel renders utilization values.
///
/// `used` is the historical default and matches the public API surface
/// (`utilization` / `used_percent` providers all report how much was burned).
/// `remaining` flips the rendering to "100 - used" so power users can read
/// limits as a countdown. Both modes still surface the same underlying number.
enum LimitDisplayMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    var id: String { rawValue }

    /// Stable identifier used by the dashboard bridge payload.
    var bridgeKey: String { rawValue }
}

/// Persists provider visibility and display order for the Usage Limits panel.
final class LimitsSettingsStore: ObservableObject {

    static let shared = LimitsSettingsStore()

    /// All known provider identifiers, in default display order.
    static let allProviders: [String] = ["claude", "codex", "cursor", "gemini", "kimi", "kiro", "grok", "copilot", "antigravity"]

    static let displayNames: [String: String] = [
        "claude": "Claude",
        "codex": "Codex",
        "cursor": "Cursor",
        "gemini": "Gemini",
        "kimi": "Kimi",
        "kiro": "Kiro",
        "grok": "Grok Build",
        "copilot": "GitHub Copilot",
        "antigravity": "Antigravity",
    ]

    static let iconNames: [String: String] = [
        "claude": "ClaudeLogo",
        "codex": "CodexLogo",
        "cursor": "CursorLogo",
        "gemini": "GeminiLogo",
        "kimi": "KimiLogo",
        "kiro": "KiroLogo",
        "copilot": "CopilotLogo",
        "antigravity": "AntigravityLogo",
    ]

    // MARK: - Published state

    /// Ordered list of provider IDs reflecting the user's preferred order.
    @Published var providerOrder: [String] {
        didSet { save() }
    }

    /// Visibility per provider. `true` = shown.
    @Published var providerVisibility: [String: Bool] {
        didSet { save() }
    }

    /// Global rendering mode for utilization values. Default `.used` so
    /// users on existing installs see no change after upgrade.
    @Published var displayMode: LimitDisplayMode {
        didSet {
            save()
            // Re-render the menu-bar percent value (StatusBarController
            // listens for this notification to refresh its composite image).
            NotificationCenter.default.post(name: .nativeSettingsChanged, object: nil)
        }
    }

    // MARK: - UserDefaults keys

    private static let orderKey = "LimitsProviderOrder"
    private static let visibilityKey = "LimitsProviderVisibility"
    private static let displayModeKey = "LimitsDisplayMode"

    // MARK: - Init

    private init() {
        let savedOrder = UserDefaults.standard.stringArray(forKey: Self.orderKey)
        let savedVis = UserDefaults.standard.dictionary(forKey: Self.visibilityKey) as? [String: Bool]

        // Merge saved order with any new providers that may have been added
        var order = savedOrder ?? Self.allProviders
        for p in Self.allProviders where !order.contains(p) {
            order.append(p)
        }
        // Remove providers no longer in allProviders
        order = order.filter { Self.allProviders.contains($0) }

        self.providerOrder = order
        self.providerVisibility = savedVis ?? Dictionary(uniqueKeysWithValues: Self.allProviders.map { ($0, true) })
        self.displayMode = Self.readDisplayMode()
    }

    private static func readDisplayMode() -> LimitDisplayMode {
        guard let raw = UserDefaults.standard.string(forKey: displayModeKey),
              let parsed = LimitDisplayMode(rawValue: raw) else {
            return .used
        }
        return parsed
    }

    // MARK: - Helpers

    func isVisible(_ id: String) -> Bool {
        providerVisibility[id] ?? true
    }

    func move(from source: IndexSet, to destination: Int) {
        var updated = providerOrder
        // MutableCollection.move is available on Array
        let items = source.map { updated[$0] }
        for index in source.sorted().reversed() {
            updated.remove(at: index)
        }
        let insertAt = min(destination, updated.count)
        updated.insert(contentsOf: items, at: insertAt)
        providerOrder = updated
    }

    private func save() {
        UserDefaults.standard.set(providerOrder, forKey: Self.orderKey)
        UserDefaults.standard.set(providerVisibility, forKey: Self.visibilityKey)
        UserDefaults.standard.set(displayMode.rawValue, forKey: Self.displayModeKey)
    }
}
