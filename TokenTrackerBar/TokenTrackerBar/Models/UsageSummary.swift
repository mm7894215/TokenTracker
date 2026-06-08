import Foundation

struct UsageSummaryResponse: Codable, Equatable {
    var from: String
    var to: String
    var days: Int
    var totals: TokenTotals
    var rolling: RollingData

    init(from: String = "", to: String = "", days: Int = 0, totals: TokenTotals = TokenTotals(), rolling: RollingData = RollingData()) {
        self.from = from; self.to = to; self.days = days; self.totals = totals; self.rolling = rolling
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
        self.to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
        self.days = try c.decodeIfPresent(Int.self, forKey: .days) ?? 0
        self.totals = try c.decodeIfPresent(TokenTotals.self, forKey: .totals) ?? TokenTotals()
        self.rolling = try c.decodeIfPresent(RollingData.self, forKey: .rolling) ?? RollingData()
    }

    private enum CodingKeys: String, CodingKey {
        case from, to, days, totals, rolling
    }
}

struct RollingData: Codable, Equatable {
    var last7d: RollingPeriod
    var last30d: RollingPeriod
    var currentMonth: RollingPeriod

    init(last7d: RollingPeriod = RollingPeriod(), last30d: RollingPeriod = RollingPeriod(), currentMonth: RollingPeriod = RollingPeriod()) {
        self.last7d = last7d; self.last30d = last30d; self.currentMonth = currentMonth
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        last7d = try c.decodeIfPresent(RollingPeriod.self, forKey: .last7d) ?? RollingPeriod()
        last30d = try c.decodeIfPresent(RollingPeriod.self, forKey: .last30d) ?? RollingPeriod()
        currentMonth = try c.decodeIfPresent(RollingPeriod.self, forKey: .currentMonth) ?? RollingPeriod()
    }

    private enum CodingKeys: String, CodingKey {
        case last7d = "last_7d"
        case last30d = "last_30d"
        case currentMonth = "current_month"
    }
}

struct RollingPeriod: Codable, Equatable {
    var from: String
    var to: String
    var activeDays: Int
    var totals: RollingTotals
    var avgPerActiveDay: Int?

    init(from: String = "", to: String = "", activeDays: Int = 0, totals: RollingTotals = RollingTotals(), avgPerActiveDay: Int? = nil) {
        self.from = from; self.to = to; self.activeDays = activeDays; self.totals = totals; self.avgPerActiveDay = avgPerActiveDay
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
        self.to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
        self.activeDays = try c.decodeIfPresent(Int.self, forKey: .activeDays) ?? 0
        self.totals = try c.decodeIfPresent(RollingTotals.self, forKey: .totals) ?? RollingTotals()
        self.avgPerActiveDay = try c.decodeIfPresent(Int.self, forKey: .avgPerActiveDay)
    }

    private enum CodingKeys: String, CodingKey {
        case from, to
        case activeDays = "active_days"
        case totals
        case avgPerActiveDay = "avg_per_active_day"
    }
}

struct RollingTotals: Codable, Equatable {
    var billableTotalTokens: Int
    var conversationCount: Int

    init(billableTotalTokens: Int = 0, conversationCount: Int = 0) {
        self.billableTotalTokens = billableTotalTokens; self.conversationCount = conversationCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        billableTotalTokens = try c.decodeIfPresent(Int.self, forKey: .billableTotalTokens) ?? 0
        conversationCount = try c.decodeIfPresent(Int.self, forKey: .conversationCount) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case billableTotalTokens = "billable_total_tokens"
        case conversationCount = "conversation_count"
    }
}
