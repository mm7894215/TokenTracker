import Foundation
import Combine

/// Persists provider visibility and display order for the Usage Limits panel.
final class LimitsSettingsStore: ObservableObject {

    static let shared = LimitsSettingsStore()

    /// All known provider identifiers, in default display order.
    static let allProviders: [String] = ["claude", "codex", "cursor", "gemini", "kiro", "antigravity"]

    static let displayNames: [String: String] = [
        "claude": "Claude",
        "codex": "Codex",
        "cursor": "Cursor",
        "gemini": "Gemini",
        "kiro": "Kiro",
        "antigravity": "Antigravity",
    ]

    static let iconNames: [String: String] = [
        "claude": "ClaudeLogo",
        "codex": "CodexLogo",
        "cursor": "CursorLogo",
        "gemini": "GeminiLogo",
        "kiro": "KiroLogo",
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

    // MARK: - UserDefaults keys

    private static let orderKey = "LimitsProviderOrder"
    private static let visibilityKey = "LimitsProviderVisibility"

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
    }
}
