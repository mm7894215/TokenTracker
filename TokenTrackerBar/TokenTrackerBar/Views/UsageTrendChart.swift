import SwiftUI
import Charts

@available(macOS 13, *)
struct UsageTrendChart: View {
	let daily: [DailyEntry]
	var monthly: [MonthlyEntry] = []
	var hourly: [HourlyEntry] = []
	@Binding var period: DateHelpers.Period
	var onPeriodChange: (DateHelpers.Period) -> Void = { _ in }

	private static let localHalfHourFormatter: DateFormatter = {
		let fmt = DateFormatter()
		fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
		fmt.timeZone = .current
		fmt.locale = Locale(identifier: "en_US_POSIX")
		return fmt
	}()

	private static let isoFormatterWithFractionalSeconds: ISO8601DateFormatter = {
		let fmt = ISO8601DateFormatter()
		fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		fmt.timeZone = .current
		return fmt
	}()

	private static let isoFormatter: ISO8601DateFormatter = {
		let fmt = ISO8601DateFormatter()
		fmt.formatOptions = [.withInternetDateTime]
		fmt.timeZone = .current
		return fmt
	}()

	private static let monthFormatter: DateFormatter = {
		let fmt = DateFormatter()
		fmt.dateFormat = "yyyy-MM"
		fmt.timeZone = .current
		fmt.locale = Locale(identifier: "en_US_POSIX")
		return fmt
	}()

	private var dailyChartData: [(date: Date, tokens: Int)] {
		let range = DateHelpers.rangeForPeriod(period)
		return daily
			.filter { $0.day >= range.from && $0.day <= range.to }
			.compactMap { entry in
				guard let date = DateHelpers.parseDay(entry.day) else { return nil }
				return (date: date, tokens: entry.totalTokens)
			}
			.sorted { $0.date < $1.date }
	}

	private var monthlyChartData: [(date: Date, tokens: Int)] {
		return monthly.compactMap { entry in
			guard let date = Self.monthFormatter.date(from: entry.month) else { return nil }
			return (date: date, tokens: entry.totalTokens)
		}
		.sorted { $0.date < $1.date }
	}

	private var hourlyChartData: [(date: Date, tokens: Int)] {
		let calendar = Calendar.current
		let currentHour = calendar.dateInterval(of: .hour, for: Date())?.start ?? Date()

		let grouped = Dictionary(grouping: hourly.compactMap { entry -> (date: Date, tokens: Int)? in
			guard let date = Self.parseHourlyDate(entry.hour),
				  let hourStart = calendar.dateInterval(of: .hour, for: date)?.start else {
				return nil
			}
			return (date: hourStart, tokens: entry.totalTokens)
		}, by: \.date)
		.map { hourStart, entries in
			(date: hourStart, tokens: entries.reduce(0) { $0 + $1.tokens })
		}
		.sorted { $0.date < $1.date }

		return grouped.filter { $0.date <= currentHour }
	}

	private static func parseHourlyDate(_ raw: String) -> Date? {
		if let date = isoFormatterWithFractionalSeconds.date(from: raw) {
			return date
		}
		if let date = isoFormatter.date(from: raw) {
			return date
		}
		return localHalfHourFormatter.date(from: raw)
	}

	private var chartData: [(date: Date, tokens: Int)] {
		switch period {
		case .day:   return hourlyChartData
		case .total: return monthlyChartData
		default:     return dailyChartData
		}
	}

	private var trendInterpolation: InterpolationMethod {
		if period == .day {
			return chartData.count > 2 ? .monotone : .linear
		}
		return chartData.count > 2 ? .catmullRom : .linear
	}

	private var dayAxisValues: [Date] {
		let data = hourlyChartData
		guard let first = data.first?.date, let last = data.last?.date else {
			return []
		}

		let calendar = Calendar.current
		let totalHours = max(1, calendar.dateComponents([.hour], from: first, to: last).hour ?? data.count)
		let stride = totalHours <= 8 ? 1 : 2
		var values: [Date] = []
		var cursor = first

		while cursor <= last {
			values.append(cursor)
			guard let next = calendar.date(byAdding: .hour, value: stride, to: cursor) else {
				break
			}
			cursor = next
		}

		if values.last != last {
			values.append(last)
		}

		return values
	}

	private var xStride: Calendar.Component {
		switch period {
		case .day:   return .hour
		case .total: return .month
		default:     return .day
		}
	}

	private var xStrideCount: Int {
		switch period {
		case .day:   return 4
		case .week:  return 1
		case .month: return 7
		case .total: return 4
		}
	}

	private var xAxisFormat: Date.FormatStyle {
		switch period {
		case .day:   return .dateTime.hour()
		case .total: return .dateTime.year(.twoDigits).month(.abbreviated)
		default:     return .dateTime.month(.abbreviated).day()
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			SectionHeader(title: Strings.trendTitle) {
				PeriodPickerView(selection: $period, onChange: onPeriodChange)
			}

			if chartData.isEmpty {
				PlaceholderBlock(height: 140, hint: Strings.hintTrend)
			} else {
				Chart(chartData, id: \.date) { point in
					AreaMark(
						x: .value("Date", point.date),
						y: .value("Tokens", point.tokens)
					)
					.foregroundStyle(Color.trendFill)
					.interpolationMethod(trendInterpolation)

					LineMark(
						x: .value("Date", point.date),
						y: .value("Tokens", point.tokens)
					)
					.foregroundStyle(Color.trendLine)
					.interpolationMethod(trendInterpolation)
				}
				.chartXAxis {
					if period == .day, !dayAxisValues.isEmpty {
						AxisMarks(values: dayAxisValues) { _ in
							AxisGridLine()
							AxisValueLabel(format: xAxisFormat)
						}
					} else {
						AxisMarks(values: .stride(by: xStride, count: xStrideCount)) { _ in
							AxisGridLine()
							AxisValueLabel(format: xAxisFormat)
						}
					}
				}
				.chartYAxis {
					AxisMarks { value in
						AxisGridLine()
						AxisValueLabel {
							if let intVal = value.as(Int.self) {
								Text(TokenFormatter.formatCompact(intVal))
							}
						}
					}
				}
				.frame(height: 140)
				.accessibilityLabel("Token usage trend chart")
			}
		}
	}
}

/// Fallback wrapper that shows the chart on macOS 13+ or a placeholder on older systems.
struct UsageTrendChartWrapper: View {
	let daily: [DailyEntry]
	var monthly: [MonthlyEntry] = []
	var hourly: [HourlyEntry] = []
	@Binding var period: DateHelpers.Period
	var onPeriodChange: (DateHelpers.Period) -> Void = { _ in }

	var body: some View {
		if #available(macOS 13, *) {
			UsageTrendChart(
				daily: daily,
				monthly: monthly,
				hourly: hourly,
				period: $period,
				onPeriodChange: onPeriodChange
			)
		} else {
			VStack(alignment: .leading, spacing: 14) {
				SectionHeader(title: Strings.trendTitle) {
					PeriodPickerView(selection: $period, onChange: onPeriodChange)
				}
				PlaceholderBlock(height: 140, hint: "Charts require macOS 13+")
			}
		}
	}
}
