import Foundation
import os

enum DateHelpers {

    private static let logger = Logger(subsystem: "com.tokentracker.bar", category: "DateHelpers")

	private static let localCalendar: Calendar = {
		var cal = Calendar(identifier: .gregorian)
		cal.timeZone = .current
		return cal
	}()

	private static let localDayFormatter: DateFormatter = {
		let fmt = DateFormatter()
		fmt.dateFormat = "yyyy-MM-dd"
		fmt.timeZone = .current
		fmt.locale = Locale(identifier: "en_US_POSIX")
		return fmt
	}()

	/// Returns the current IANA time zone identifier.
	static var currentTimeZoneIdentifier: String {
		TimeZone.current.identifier
	}

	/// Returns the current UTC offset in minutes for the given date.
	static func currentUTCOffsetMinutes(for date: Date = Date()) -> Int {
		TimeZone.current.secondsFromGMT(for: date) / 60
	}

	/// Returns today's date as "YYYY-MM-DD" in the current local time zone.
	static func todayString() -> String {
		localDayFormatter.string(from: Date())
	}

	/// Returns the date N days ago as "YYYY-MM-DD" in the current local time zone.
	static func daysAgoString(_ n: Int) -> String {
		let date = localCalendar.date(byAdding: .day, value: -n, to: Date()) ?? Date()
		return localDayFormatter.string(from: date)
	}

	/// Parses a "YYYY-MM-DD" string into a Date in the current local time zone.
	static func parseDay(_ s: String) -> Date? {
		let result = localDayFormatter.date(from: s)
		if result == nil {
			logger.warning("Failed to parse date string: \(s, privacy: .public)")
		}
		return result
	}

	/// Returns the date N months ago as "YYYY-MM-DD" in the current local time zone.
	static func monthsAgoString(_ n: Int) -> String {
		let date = localCalendar.date(byAdding: .month, value: -n, to: Date()) ?? Date()
		return localDayFormatter.string(from: date)
	}

    // MARK: - Period

    enum Period: String, CaseIterable, Identifiable {
        case day, week, month, total
        var id: String { rawValue }

        var label: String {
            switch self {
            case .day:   return Strings.periodDayLabel
            case .week:  return Strings.periodWeekLabel
            case .month: return Strings.periodMonthLabel
            case .total: return Strings.periodTotalLabel
            }
        }
    }

    /// Returns (from, to) date strings for a given period.
    static func rangeForPeriod(_ period: Period) -> (from: String, to: String) {
        let now = Date()
        let today = localDayFormatter.string(from: now)

        switch period {
        case .day:
            return (from: today, to: today)

        case .week:
            // Monday-start week
            let weekday = localCalendar.component(.weekday, from: now)
            // weekday: 1=Sun,2=Mon,...,7=Sat → offset to Monday
            let daysFromMonday = (weekday + 5) % 7
            let monday = localCalendar.date(byAdding: .day, value: -daysFromMonday, to: now) ?? now
            let sunday = localCalendar.date(byAdding: .day, value: 6, to: monday) ?? now
            return (from: localDayFormatter.string(from: monday), to: localDayFormatter.string(from: sunday))

        case .month:
            // First and last day of current month
            guard let monthStart = localCalendar.date(from: localCalendar.dateComponents([.year, .month], from: now)) else {
                return (from: today, to: today)
            }
            guard let nextMonth = localCalendar.date(byAdding: .month, value: 1, to: monthStart),
                  let monthEnd = localCalendar.date(byAdding: .day, value: -1, to: nextMonth) else {
                return (from: localDayFormatter.string(from: monthStart), to: today)
            }
            return (from: localDayFormatter.string(from: monthStart), to: localDayFormatter.string(from: monthEnd))

        case .total:
            // Last 24 months
            let start = localCalendar.date(byAdding: .month, value: -24, to: now) ?? now
            guard let monthStart = localCalendar.date(from: localCalendar.dateComponents([.year, .month], from: start)) else {
                return (from: monthsAgoString(24), to: today)
            }
            return (from: localDayFormatter.string(from: monthStart), to: today)
        }
    }
}
