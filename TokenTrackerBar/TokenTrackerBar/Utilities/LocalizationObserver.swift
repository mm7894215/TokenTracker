import Combine
import Foundation

@MainActor
final class LocalizationObserver: ObservableObject {
    static let shared = LocalizationObserver()

    @Published private(set) var revision = 0

    var resolvedLocale: String {
        NativeLocalization.currentResolvedLocale
    }

    private init() {}

    func storePreference(_ value: Any?) {
        let before = NativeLocalization.currentResolvedLocale
        NativeLocalization.storePreference(value)
        let after = NativeLocalization.currentResolvedLocale
        revision += before == after ? 0 : 1
    }
}
