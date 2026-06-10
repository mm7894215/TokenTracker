import XCTest
import Combine

final class LimitsSettingsStoreTests: XCTestCase {
    private var cancellables: Set<AnyCancellable> = []

    override func tearDown() {
        cancellables.removeAll()
        super.tearDown()
    }

    func testReorderMovingDownUsesOriginalDestinationOffset() {
        let order = LimitsSettingsStore.allProviders

        let reordered = LimitsSettingsStore.reorderedProviderOrder(
            order,
            moving: IndexSet(integer: 0),
            to: 2
        )

        XCTAssertEqual(Array(reordered.prefix(3)), ["codex", "claude", "cursor"])
    }

    func testReorderMovingUpUsesOriginalDestinationOffset() {
        let order = LimitsSettingsStore.allProviders

        let reordered = LimitsSettingsStore.reorderedProviderOrder(
            order,
            moving: IndexSet(integer: 2),
            to: 1
        )

        XCTAssertEqual(Array(reordered.prefix(3)), ["claude", "cursor", "codex"])
    }

    func testBridgeSnapshotDoesNotPublishPreferenceChange() {
        let (store, _) = makeStore()
        let notPublished = expectation(description: "bridge snapshot does not republish to Dashboard")
        notPublished.isInverted = true
        store.preferencesDidChange
            .sink { notPublished.fulfill() }
            .store(in: &cancellables)

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "claude"],
            "providerVisibility": ["claude": false],
            "updatedAt": NSNumber(value: 10),
        ]))

        wait(for: [notPublished], timeout: 0.05)
        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerVisibility["claude"], false)
        XCTAssertEqual(store.updatedAt, 10)
    }

    func testMenuChangePublishesPreferenceChangeAndPersistsSnapshot() {
        let (store, defaults) = makeStore()
        let published = expectation(description: "menu changes publish to Dashboard")
        store.preferencesDidChange
            .sink { published.fulfill() }
            .store(in: &cancellables)

        store.setDisplayModeFromMenu(.remaining)

        wait(for: [published], timeout: 0.05)
        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(defaults.string(forKey: "LimitsDisplayMode"), "remaining")
        XCTAssertNotNil(defaults.object(forKey: "LimitsPreferencesUpdatedAt"))
    }

    func testBridgeSnapshotRejectsOlderUpdatedAt() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "updatedAt": NSNumber(value: 20),
        ]))
        XCTAssertFalse(store.applyBridgeSnapshot([
            "displayMode": "used",
            "updatedAt": NSNumber(value: 19),
        ]))

        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(store.updatedAt, 20)
    }

    func testBridgeSnapshotWithSameUpdatedAtAppliesDashboardTieBreak() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "used",
            "providerOrder": ["claude", "codex"],
            "updatedAt": NSNumber(value: 30),
        ]))
        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "claude"],
            "providerVisibility": ["gemini": false],
            "updatedAt": NSNumber(value: 30),
        ]))

        XCTAssertEqual(store.displayMode, .remaining)
        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerVisibility["gemini"], false)
        XCTAssertEqual(store.updatedAt, 30)
    }

    func testBridgeSnapshotWithoutUpdatedAtOnlyAppliesBeforeMigration() {
        let (unmigrated, _) = makeStore()
        XCTAssertTrue(unmigrated.applyBridgeSnapshot([
            "displayMode": "remaining",
        ]))
        XCTAssertEqual(unmigrated.displayMode, .remaining)
        XCTAssertNil(unmigrated.updatedAt)

        let (migrated, _) = makeStore()
        XCTAssertTrue(migrated.applyBridgeSnapshot([
            "displayMode": "used",
            "updatedAt": NSNumber(value: 40),
        ]))
        XCTAssertFalse(migrated.applyBridgeSnapshot([
            "displayMode": "remaining",
        ]))
        XCTAssertEqual(migrated.displayMode, .used)
        XCTAssertEqual(migrated.updatedAt, 40)
    }

    func testBridgeSnapshotNormalizesProvidersAndUpdatedAt() {
        let (store, _) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["gemini", "unknown", "claude", "gemini"],
            "providerVisibility": [
                "claude": false,
                "codex": NSNumber(value: 1),
                "unknown": false,
            ],
            "updatedAt": NSNumber(value: 42.5),
        ]))

        XCTAssertEqual(Array(store.providerOrder.prefix(2)), ["gemini", "claude"])
        XCTAssertEqual(store.providerOrder.count, LimitsSettingsStore.allProviders.count)
        XCTAssertEqual(store.providerVisibility["claude"], false)
        XCTAssertEqual(store.providerVisibility["codex"], true)
        XCTAssertNil(store.providerVisibility["unknown"])
        XCTAssertNil(store.updatedAt)
    }

    func testBridgeSnapshotPersistsUserDefaultsMirror() {
        let (store, defaults) = makeStore()

        XCTAssertTrue(store.applyBridgeSnapshot([
            "displayMode": "remaining",
            "providerOrder": ["codex", "claude"],
            "providerVisibility": ["claude": false],
            "updatedAt": NSNumber(value: 50),
        ]))

        XCTAssertEqual(defaults.string(forKey: "LimitsDisplayMode"), "remaining")
        XCTAssertEqual(defaults.stringArray(forKey: "LimitsProviderOrder")?.prefix(2), ["codex", "claude"])
        XCTAssertEqual(defaults.dictionary(forKey: "LimitsProviderVisibility")?["claude"] as? Bool, false)
        XCTAssertEqual(defaults.object(forKey: "LimitsPreferencesUpdatedAt") as? Int64, 50)
    }

    private func makeStore(
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> (LimitsSettingsStore, UserDefaults) {
        let suiteName = "LimitsSettingsStoreTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Unable to create test UserDefaults suite", file: file, line: line)
            return (LimitsSettingsStore(userDefaults: .standard), .standard)
        }
        defaults.removePersistentDomain(forName: suiteName)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suiteName)
        }
        return (LimitsSettingsStore(userDefaults: defaults), defaults)
    }
}
