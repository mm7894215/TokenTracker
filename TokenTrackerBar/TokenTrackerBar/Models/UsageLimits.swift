import Foundation

struct UsageLimitsResponse: Codable, Equatable {
    let fetchedAt: String
    let claude: ClaudeLimits
    let codex: CodexLimits
    let cursor: CursorLimits
    let gemini: GeminiLimits
    let kimi: KimiLimits?
    let kiro: KiroLimits
    let grok: GrokLimits?
    let antigravity: AntigravityLimits
    let copilot: CopilotLimits?

    enum CodingKeys: String, CodingKey {
        case fetchedAt = "fetched_at"
        case claude, codex, cursor, gemini, kimi, kiro, grok, antigravity, copilot
    }
}

struct ClaudeLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let fiveHour: ClaudeWindow?
    let sevenDay: ClaudeWindow?
    let sevenDayOpus: ClaudeWindow?
    let extraUsage: ClaudeExtraUsage?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
        case sevenDayOpus = "seven_day_opus"
        case extraUsage = "extra_usage"
    }
}

struct ClaudeWindow: Codable, Equatable {
    let utilization: Double
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }
}

struct ClaudeExtraUsage: Codable, Equatable {
    let isEnabled: Bool
    let monthlyLimit: Int?
    let usedCredits: Int?
    let currency: String?

    enum CodingKeys: String, CodingKey {
        case isEnabled = "is_enabled"
        case monthlyLimit = "monthly_limit"
        case usedCredits = "used_credits"
        case currency
    }
}

struct CodexLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: CodexWindow?
    let secondaryWindow: CodexWindow?
    let sparkPrimaryWindow: CodexWindow?
    let sparkSecondaryWindow: CodexWindow?
    let resetCredits: ResetCredits?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case sparkPrimaryWindow = "spark_primary_window"
        case sparkSecondaryWindow = "spark_secondary_window"
        case resetCredits = "reset_credits"
    }

    struct ResetCredits: Codable, Equatable {
        let availableCount: Int?
        let totalEarnedCount: Int?
        let credits: [ResetCredit]

        enum CodingKeys: String, CodingKey {
            case availableCount = "available_count"
            case totalEarnedCount = "total_earned_count"
            case credits
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            availableCount = try container.decodeIfPresent(Int.self, forKey: .availableCount)
            totalEarnedCount = try container.decodeIfPresent(Int.self, forKey: .totalEarnedCount)
            credits = try container.decodeIfPresent([ResetCredit].self, forKey: .credits) ?? []
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(availableCount, forKey: .availableCount)
            try container.encodeIfPresent(totalEarnedCount, forKey: .totalEarnedCount)
            try container.encode(credits, forKey: .credits)
        }
    }

    struct ResetCredit: Codable, Equatable {
        let status: String
        let resetType: String?
        let grantedAt: String?
        let expiresAt: String

        enum CodingKeys: String, CodingKey {
            case status
            case resetType = "reset_type"
            case grantedAt = "granted_at"
            case expiresAt = "expires_at"
        }
    }
}

struct CodexWindow: Codable, Equatable {
    let usedPercent: Int
    let resetAt: Int?
    let limitWindowSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetAt = "reset_at"
        case limitWindowSeconds = "limit_window_seconds"
    }
}

struct GenericLimitWindow: Codable, Equatable {
    let usedPercent: Double
    let resetAt: String?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetAt = "reset_at"
    }
}

struct CursorLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let membershipType: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case membershipType = "membership_type"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct KimiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let membershipLevel: String?
    let subscriptionType: String?
    let parallelLimit: Int?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case membershipLevel = "membership_level"
        case subscriptionType = "subscription_type"
        case parallelLimit = "parallel_limit"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct KiroLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct GeminiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct GrokLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct CopilotLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct AntigravityLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planLabel: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planLabel = "plan_label"
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

/// Helper to decide whether a response from the limits API contains at least one
/// usable (configured + no error) provider record. Used by the ViewModel to
/// protect the "last good record" on partial failures (do not overwrite a
/// previously successful snapshot with an all-error response).
extension UsageLimitsResponse {
    var hasAnyProviderWithoutError: Bool {
        let providers: [(Bool, String?)] = [
            (claude.configured, claude.error),
            (codex.configured, codex.error),
            (cursor.configured, cursor.error),
            (gemini.configured, gemini.error),
            (kimi?.configured ?? false, kimi?.error),
            (kiro.configured, kiro.error),
            (grok?.configured ?? false, grok?.error),
            (antigravity.configured, antigravity.error),
            (copilot?.configured ?? false, copilot?.error),
        ]
        return providers.contains { $0.0 && $0.1 == nil }
    }

    /// Decide which record the UI should display after a successful fetch:
    /// adopt the incoming response unless it has no usable provider data while a
    /// previous record exists (keeps the last good snapshot on an all-error response).
    static func displayRecord(
        current: UsageLimitsResponse?,
        incoming: UsageLimitsResponse
    ) -> UsageLimitsResponse {
        guard let current, !incoming.hasAnyProviderWithoutError else { return incoming }
        return current
    }
}
