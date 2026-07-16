import XCTest

final class MenuBarDisplayPreferencesTests: XCTestCase {

    func testHiddenProviderExcludedEvenWhenSelected() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [MenuBarDisplayMetric.claude5h.rawValue],
            hiddenProviders: ["claude"]
        )

        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.claude5h.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.claude7d.rawValue))
    }

    func testHiddenProviderDoesNotAffectTokenCostMetrics() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            hiddenProviders: Set(LimitsSettingsStore.allProviders)
        )

        XCTAssertEqual(ids, [
            MenuBarDisplayMetric.todayTokens.rawValue,
            MenuBarDisplayMetric.todayCost.rawValue,
            MenuBarDisplayMetric.last7dTokens.rawValue,
            MenuBarDisplayMetric.totalTokens.rawValue,
            MenuBarDisplayMetric.totalCost.rawValue,
        ])
    }

    func testHiddenProviderOnlyRemovesItsOwnMetrics() {
        let withoutHidden = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [
                MenuBarDisplayMetric.claude5h.rawValue,
                MenuBarDisplayMetric.codex5h.rawValue,
            ]
        )
        let withHidden = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [
                MenuBarDisplayMetric.claude5h.rawValue,
                MenuBarDisplayMetric.codex5h.rawValue,
            ],
            hiddenProviders: ["claude"]
        )

        XCTAssertTrue(withoutHidden.contains(MenuBarDisplayMetric.claude5h.rawValue))
        XCTAssertEqual(
            withHidden,
            withoutHidden.filter { MenuBarDisplayMetric(rawValue: $0)?.providerKey != "claude" }
        )
        XCTAssertTrue(withHidden.contains(MenuBarDisplayMetric.codex5h.rawValue))
    }

    func testDefaultKeepsSelectedMetricWhileLimitsUnknown() {
        let ids = MenuBarDisplayPreferences.availableItemIDs(
            keepingSelected: [MenuBarDisplayMetric.claude5h.rawValue]
        )

        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.claude5h.rawValue))
    }

    func testCodexCreditMetricAppearsWhenCreditWindowExists() throws {
        let limits = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "credit_window": [
                    "used_percent": 0.14,
                    "limit_credits": 37_500,
                    "used_credits": 51.03,
                    "remaining_credits": 37_448.97,
                    "reset_at": 1_785_542_400,
                ],
            ],
        ])

        let ids = MenuBarDisplayPreferences.availableItemIDs(for: limits)

        XCTAssertTrue(ids.contains(MenuBarDisplayMetric.codexCredits.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.codex5h.rawValue))
        XCTAssertFalse(ids.contains(MenuBarDisplayMetric.codex7d.rawValue))
    }

    /// Every limit metric's providerKey must be a known LimitsSettingsStore
    /// provider id, or visibility filtering silently never matches it.
    func testProviderKeysMatchLimitsSettingsStoreProviders() {
        let known = Set(LimitsSettingsStore.allProviders)
        for metric in MenuBarDisplayMetric.allCases {
            guard let provider = metric.providerKey else { continue }
            XCTAssertTrue(
                known.contains(provider),
                "providerKey \(provider) for \(metric.rawValue) missing from LimitsSettingsStore.allProviders"
            )
        }
    }

    func testIconPreferenceDefaultsToClaudeIndependentlyOfMetrics() throws {
        let (defaults, suiteName) = try makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set([
            MenuBarDisplayMetric.codex7d.rawValue,
            MenuBarDisplayMetric.todayTokens.rawValue,
        ], forKey: MenuBarDisplayPreferences.key)

        XCTAssertEqual(MenuBarIconPreference.read(from: defaults), .claude)
    }

    func testIconPreferenceCanBeSelectedIndependentlyOfMetrics() throws {
        let (defaults, suiteName) = try makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set([
            MenuBarDisplayMetric.todayTokens.rawValue,
            MenuBarDisplayMetric.todayCost.rawValue,
        ], forKey: MenuBarDisplayPreferences.key)

        MenuBarIconPreference.write(.openAI, to: defaults)
        XCTAssertEqual(MenuBarIconPreference.read(from: defaults), .openAI)

        MenuBarIconPreference.write(.claude, to: defaults)
        XCTAssertEqual(MenuBarIconPreference.read(from: defaults), .claude)
    }

    private func decodeResponse(overrides: [String: Any] = [:]) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-07-01T00:00:00Z",
            "claude": ["configured": false],
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides {
            payload[key] = value
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(UsageLimitsResponse.self, from: data)
    }

    private func makeIsolatedDefaults() throws -> (UserDefaults, String) {
        let suiteName = "MenuBarDisplayPreferencesTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }
}
