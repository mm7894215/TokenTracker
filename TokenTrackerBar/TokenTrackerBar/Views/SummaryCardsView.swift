import SwiftUI

struct SummaryCardsView: View {
    let todayTokens: Int
    let todayCost: String
    let last7dTokens: Int
    let last7dActiveDays: Int
    let last30dTokens: Int
    let last30dAvgPerDay: Int
    let totalTokens: Int
    let totalCost: String

    var body: some View {
        HStack(spacing: 6) {
            StatCard(
                title: Strings.todayTitle,
                value: TokenFormatter.formatCompact(todayTokens),
                subtitle: todayCost
            )

            StatCard(
                title: Strings.sevenDayTitle,
                value: TokenFormatter.formatCompact(last7dTokens),
                subtitle: Strings.activeDays(last7dActiveDays)
            )

            StatCard(
                title: Strings.thirtyDayTitle,
                value: TokenFormatter.formatCompact(last30dTokens),
                subtitle: "~\(TokenFormatter.formatCompact(last30dAvgPerDay))\(Strings.perDay)"
            )

            StatCard(
                title: Strings.totalTitle,
                value: TokenFormatter.formatCompact(totalTokens),
                subtitle: totalCost
            )
        }
    }
}

private struct StatCard: View {
    let title: String
    let value: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.title3, design: .rounded).weight(.bold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .modifier(NumericTextTransitionModifier(value: value))
            Text(subtitle)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(Color.primary.opacity(0.065))
                .overlay(
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.5)
                )
        )
        .accessibilityElement(children: .combine)
    }
}
