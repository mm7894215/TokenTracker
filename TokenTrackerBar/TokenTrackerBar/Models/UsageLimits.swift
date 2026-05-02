import Foundation

struct UsageLimitsResponse: Codable, Equatable {
    let fetchedAt: String
    let claude: ClaudeLimits
    let codex: CodexLimits
    let cursor: CursorLimits
    let gemini: GeminiLimits
    let kimi: KimiLimits?
    let kiro: KiroLimits
    let antigravity: AntigravityLimits
    let copilot: CopilotLimits?

    enum CodingKeys: String, CodingKey {
        case fetchedAt = "fetched_at"
        case claude, codex, cursor, gemini, kimi, kiro, antigravity, copilot
    }
}

struct ClaudeLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let fiveHour: ClaudeWindow?
    let sevenDay: ClaudeWindow?
    let sevenDayOpus: ClaudeWindow?
    let extraUsage: ClaudeExtraUsage?

    enum CodingKeys: String, CodingKey {
        case configured, error
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
    let primaryWindow: CodexWindow?
    let secondaryWindow: CodexWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
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
    let membershipType: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case membershipType = "membership_type"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct KimiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let membershipLevel: String?
    let subscriptionType: String?
    let parallelLimit: Int?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
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
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct GeminiLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}

struct CopilotLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let planName: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case planName = "plan_name"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct AntigravityLimits: Codable, Equatable {
    let configured: Bool
    let error: String?
    let accountEmail: String?
    let accountPlan: String?
    let primaryWindow: GenericLimitWindow?
    let secondaryWindow: GenericLimitWindow?
    let tertiaryWindow: GenericLimitWindow?

    enum CodingKeys: String, CodingKey {
        case configured, error
        case accountEmail = "account_email"
        case accountPlan = "account_plan"
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
        case tertiaryWindow = "tertiary_window"
    }
}
