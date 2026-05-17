import Foundation

enum WidgetStrings {
    private static var zh: Bool { NativeLocalization.usesChinese }
    private static func t(_ en: String, _ zhCN: String) -> String { zh ? zhCN : en }

    static var usageName: String { t("Usage", "使用情况") }
    static var usageDescription: String { t("Today's tokens at a glance, with trend.", "快速查看今日 tokens 和趋势。") }
    static var today: String { t("TODAY", "今日") }
    static var sevenDays: String { t("7 DAYS", "7 天") }
    static var thirtyDays: String { t("30 DAYS", "30 天") }
    static var vsYesterday: String { t("vs. yesterday", "较昨日") }

    static var heatmapName: String { t("Activity Heatmap", "活跃热力图") }
    static var heatmapDescription: String { t("GitHub-style daily activity calendar.", "类似 GitHub 的每日活跃日历。") }
    static func streak(_ days: Int) -> String { zh ? "连续 \(days) 天" : "\(days)d streak" }
    static func tokensActiveDays(activeDays: Int) -> String {
        zh ? "tokens · \(activeDays) 个活跃日" : "tokens · \(activeDays) active days"
    }

    static var limitsName: String { t("Usage Limits", "使用限额") }
    static var limitsDescription: String { t("Rate limits for Claude, Codex, Cursor, Gemini, and more.", "Claude、Codex、Cursor、Gemini 等工具的速率限额。") }
    static var noConfiguredProviders: String { t("No configured providers", "暂无已配置提供方") }

    static var topModelsName: String { t("Top Models", "热门模型") }
    static var topModelsDescription: String { t("Models with the highest token usage.", "Token 用量最高的模型。") }
    static var noModelUsage: String { t("No model usage yet", "暂无模型使用数据") }

    static func updated(_ relative: String) -> String {
        zh ? "更新于 \(relative)" : "Updated \(relative)"
    }

    static var justNow: String { t("just now", "刚刚") }
    static func minutesAgo(_ minutes: Int) -> String { zh ? "\(minutes) 分钟前" : "\(minutes)m ago" }
    static func hoursAgo(_ hours: Int) -> String { zh ? "\(hours) 小时前" : "\(hours)h ago" }
    static func daysAgo(_ days: Int) -> String { zh ? "\(days) 天前" : "\(days)d ago" }
    static func resetInMinutes(_ minutes: Int) -> String { zh ? "\(minutes) 分钟后" : "in \(minutes)m" }
    static func resetInHours(_ hours: Int, minutes: Int) -> String {
        if zh {
            return minutes > 0 ? "\(hours) 小时 \(minutes) 分钟后" : "\(hours) 小时后"
        }
        return minutes > 0 ? "in \(hours)h \(minutes)m" : "in \(hours)h"
    }
    static func resetInDays(_ days: Int) -> String { zh ? "\(days) 天后" : "in \(days)d" }

    static func limitLabel(_ limit: LimitProvider) -> String {
        guard zh else { return limit.label }
        let label = limit.label
        let source = limit.source.capitalized
        if label.contains("5h") { return "\(source) · 5小时" }
        if label.contains("7d Opus") { return "\(source) · 7天 Opus" }
        if label.contains("7d") || label.contains("weekly") { return "\(source) · 7天" }
        if label == "Cursor" { return "Cursor · 套餐" }
        return label
    }
}
