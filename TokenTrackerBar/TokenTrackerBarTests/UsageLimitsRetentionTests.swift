import XCTest

/// Covers the "retain last usage limits record" feature: the
/// `hasAnyProviderWithoutError` predicate and the `displayRecord` retention
/// rule used by DashboardViewModel after a successful limits fetch.
final class UsageLimitsRetentionTests: XCTestCase {

    // MARK: - hasAnyProviderWithoutError

    func testAllProvidersUnconfiguredHasNoUsableProvider() throws {
        let response = try decodeResponse()

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    func testAllConfiguredProvidersErroredHasNoUsableProvider() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "codex": ["configured": true, "error": "timeout"],
        ])

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    func testSingleConfiguredErrorFreeProviderIsUsable() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testUsableProviderAmongErroredOnesIsStillUsable() throws {
        let response = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "kiro": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testOptionalProviderCountsWhenUsable() throws {
        let response = try decodeResponse(overrides: [
            "grok": ["configured": true],
        ])

        XCTAssertTrue(response.hasAnyProviderWithoutError)
    }

    func testOptionalProviderWithErrorDoesNotCount() throws {
        let response = try decodeResponse(overrides: [
            "copilot": ["configured": true, "error": "rate limited"],
        ])

        XCTAssertFalse(response.hasAnyProviderWithoutError)
    }

    // MARK: - displayRecord retention rule

    func testDisplayRecordAdoptsIncomingWhenNoCurrentRecord() throws {
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: nil, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    func testDisplayRecordAdoptsUsableIncomingOverCurrent() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "plan_label": "Max"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    func testDisplayRecordKeepsCurrentWhenIncomingHasNoUsableProvider() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "connection refused"],
            "codex": ["configured": true, "error": "connection refused"],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, current)
    }

    func testDisplayRecordAdoptsPartiallyUsableIncoming() throws {
        let current = try decodeResponse(overrides: [
            "claude": ["configured": true],
            "codex": ["configured": true],
        ])
        let incoming = try decodeResponse(overrides: [
            "claude": ["configured": true, "error": "401 unauthorized"],
            "codex": ["configured": true],
        ])

        let displayed = UsageLimitsResponse.displayRecord(current: current, incoming: incoming)

        XCTAssertEqual(displayed, incoming)
    }

    // MARK: - Fixtures

    /// Builds a UsageLimitsResponse via JSON decoding (the same path production
    /// data takes). All required providers default to unconfigured; pass
    /// per-provider dictionaries to override or to add optional providers
    /// (kimi / grok / copilot).
    private func decodeResponse(overrides: [String: Any] = [:]) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-06-10T00:00:00Z",
            "claude": ["configured": false],
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides { payload[key] = value }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(UsageLimitsResponse.self, from: data)
    }
}
