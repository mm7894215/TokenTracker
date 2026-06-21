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

    func testCodexResetCreditsMissingFromOldPayloadDecodesAsNil() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "plan_label": "Plus",
                "primary_window": [
                    "used_percent": 42,
                    "reset_at": 1_782_000_000,
                    "limit_window_seconds": 18_000,
                ],
            ],
        ])

        XCTAssertEqual(response.codex.planLabel, "Plus")
        XCTAssertEqual(response.codex.primaryWindow?.usedPercent, 42)
        XCTAssertNil(response.codex.resetCredits)
    }

    func testCodexResetCreditsFullPayloadDecodesWhitelistedFields() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 2,
                    "total_earned_count": 5,
                    "private_note": "ignored",
                    "credits": [
                        [
                            "status": "available",
                            "reset_type": "weekly",
                            "granted_at": "2026-06-20T08:00:00.123456Z",
                            "expires_at": "2026-06-27T08:00:00.654321Z",
                            "internal_id": "ignored",
                        ],
                        [
                            "status": "expired",
                            "expires_at": "2026-06-19T08:00:00.000001Z",
                        ],
                    ],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 2)
        XCTAssertEqual(resetCredits.totalEarnedCount, 5)
        XCTAssertEqual(resetCredits.credits.count, 2)
        XCTAssertEqual(resetCredits.credits[0].status, "available")
        XCTAssertEqual(resetCredits.credits[0].resetType, "weekly")
        XCTAssertEqual(resetCredits.credits[0].grantedAt, "2026-06-20T08:00:00.123456Z")
        XCTAssertEqual(resetCredits.credits[0].expiresAt, "2026-06-27T08:00:00.654321Z")
        XCTAssertEqual(resetCredits.credits[1].status, "expired")
        XCTAssertNil(resetCredits.credits[1].resetType)
        XCTAssertNil(resetCredits.credits[1].grantedAt)
        XCTAssertEqual(resetCredits.credits[1].expiresAt, "2026-06-19T08:00:00.000001Z")
    }

    func testCodexResetCreditsCountOnlyPayloadDecodesWithEmptyCredits() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 1,
                    "total_earned_count": NSNull(),
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 1)
        XCTAssertNil(resetCredits.totalEarnedCount)
        XCTAssertEqual(resetCredits.credits, [])
    }

    func testCodexResetCreditsZeroPayloadDecodesEmptyCredits() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 0,
                    "total_earned_count": 0,
                    "credits": [],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.availableCount, 0)
        XCTAssertEqual(resetCredits.totalEarnedCount, 0)
        XCTAssertEqual(resetCredits.credits, [])
    }

    func testCodexResetCreditsMicrosecondPayloadDecodesRawExpiry() throws {
        let response = try decodeResponse(overrides: [
            "codex": [
                "configured": true,
                "reset_credits": [
                    "available_count": 1,
                    "credits": [
                        [
                            "status": "available",
                            "expires_at": "2026-07-12T02:13:21.590541Z",
                        ],
                    ],
                ],
            ],
        ])

        let resetCredits = try XCTUnwrap(response.codex.resetCredits)
        XCTAssertEqual(resetCredits.credits.count, 1)
        XCTAssertEqual(resetCredits.credits[0].expiresAt, "2026-07-12T02:13:21.590541Z")
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
