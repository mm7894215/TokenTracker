import Foundation

public enum NativeLocalization {
    public static let preferenceKey = "tokentracker-locale"
    public static let systemPreference = "system"
    public static let englishLocale = "en"
    public static let chineseLocale = "zh-CN"

    private static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: WidgetSharedConstants.appGroupIdentifier)
    }

    public static func normalizePreference(_ value: Any?) -> String {
        guard let raw = value as? String else { return systemPreference }
        if raw == systemPreference { return systemPreference }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("zh")
            ? chineseLocale
            : englishLocale
    }

    public static var currentPreference: String {
        if let shared = sharedDefaults?.string(forKey: preferenceKey) {
            return normalizePreference(shared)
        }
        return normalizePreference(UserDefaults.standard.string(forKey: preferenceKey))
    }

    public static var currentResolvedLocale: String {
        resolveLocale(preference: currentPreference)
    }

    public static var usesChinese: Bool {
        currentResolvedLocale == chineseLocale
    }

    public static func resolveLocale(
        preference: String? = nil,
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> String {
        let normalized = normalizePreference(preference ?? currentPreference)
        guard normalized == systemPreference else { return normalized }
        // Use only the primary (most preferred) language, not any zh entry in the list.
        // Many English macOS users keep zh-Hans-CN as a secondary preferred language for
        // input methods or fallback menus — scanning the whole array mis-resolves their
        // primary "en" to Chinese. See issue #54.
        let primary = preferredLanguages
            .lazy
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let primary else { return englishLocale }
        return primary.range(of: #"^zh([-_]|$)"#, options: .regularExpression) != nil
            ? chineseLocale
            : englishLocale
    }

    public static func storePreference(_ value: Any?) {
        let normalized = normalizePreference(value)
        UserDefaults.standard.set(normalized, forKey: preferenceKey)
        sharedDefaults?.set(normalized, forKey: preferenceKey)
    }
}
