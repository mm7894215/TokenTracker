import Foundation

actor APIClient {
    static let shared = APIClient()
    private struct LocalAuthResponse: Decodable {
        let token: String
    }

    private let baseURL = Constants.serverBaseURL
    private let session: URLSession
    private let decoder: JSONDecoder

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)

        let jsonDecoder = JSONDecoder()
        // No .convertFromSnakeCase — all models use explicit CodingKeys with snake_case rawValues
        self.decoder = jsonDecoder
    }

    // MARK: - Public API

	func fetchSummary(from: String, to: String) async throws -> UsageSummaryResponse {
		try await fetch("/functions/tokentracker-usage-summary", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "from", value: from),
			URLQueryItem(name: "to", value: to)
		]))
	}

	func fetchDaily(from: String, to: String) async throws -> DailyUsageResponse {
		try await fetch("/functions/tokentracker-usage-daily", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "from", value: from),
			URLQueryItem(name: "to", value: to)
		]))
	}

	func fetchHeatmap(weeks: Int = 52) async throws -> HeatmapResponse {
		try await fetch("/functions/tokentracker-usage-heatmap", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "weeks", value: String(weeks))
		]))
	}

	func fetchModelBreakdown(from: String, to: String) async throws -> ModelBreakdownResponse {
		try await fetch("/functions/tokentracker-usage-model-breakdown", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "from", value: from),
			URLQueryItem(name: "to", value: to)
		]))
	}

	func fetchProjectUsage(from: String, to: String) async throws -> ProjectUsageResponse {
		try await fetch("/functions/tokentracker-project-usage-summary", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "from", value: from),
			URLQueryItem(name: "to", value: to)
		]))
	}

	func fetchMonthly(from: String, to: String) async throws -> MonthlyUsageResponse {
		try await fetch("/functions/tokentracker-usage-monthly", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "from", value: from),
			URLQueryItem(name: "to", value: to)
		]))
	}

	func fetchHourly(day: String) async throws -> HourlyUsageResponse {
		try await fetch("/functions/tokentracker-usage-hourly", queryItems: withTimeZoneQueryItems([
			URLQueryItem(name: "day", value: day)
		]))
	}

    func fetchUsageLimits() async throws -> UsageLimitsResponse {
        try await fetch("/functions/tokentracker-usage-limits")
    }

    func triggerSync() async throws -> SyncResponse {
        try await post("/functions/tokentracker-local-sync")
    }

    func checkServerHealth() async -> Bool {
        do {
            guard let url = URL(string: baseURL + "/functions/tokentracker-user-status") else {
                return false
            }
            let (_, response) = try await session.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            return httpResponse.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Private Helpers

    private func fetch<T: Decodable>(_ path: String, queryItems: [URLQueryItem] = []) async throws -> T {
        guard var components = URLComponents(string: baseURL + path) else {
            throw APIError.invalidURL
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }
        let (data, response) = try await session.data(from: url)
        try validateResponse(response)
        return try decoder.decode(T.self, from: data)
    }

	private func withTimeZoneQueryItems(_ items: [URLQueryItem]) -> [URLQueryItem] {
		items + [
			URLQueryItem(name: "tz", value: DateHelpers.currentTimeZoneIdentifier),
			URLQueryItem(name: "tz_offset_minutes", value: String(DateHelpers.currentUTCOffsetMinutes()))
		]
	}

    private func post<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if path == "/functions/tokentracker-local-sync" {
            request.setValue(try await fetchLocalAuthToken(), forHTTPHeaderField: "x-tokentracker-local-auth")
        }
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)
        return try decoder.decode(T.self, from: data)
    }

    private func fetchLocalAuthToken() async throws -> String {
        guard let url = URL(string: baseURL + "/api/local-auth") else {
            throw APIError.invalidURL
        }
        let (data, response) = try await session.data(from: url)
        try validateResponse(response)
        let payload = try decoder.decode(LocalAuthResponse.self, from: data)
        guard !payload.token.isEmpty else {
            throw APIError.invalidResponse
        }
        return payload.token
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(statusCode: httpResponse.statusCode)
        }
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let statusCode):
            return "HTTP error: \(statusCode)"
        }
    }
}
