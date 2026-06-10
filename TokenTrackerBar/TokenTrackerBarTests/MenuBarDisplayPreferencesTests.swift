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
}
