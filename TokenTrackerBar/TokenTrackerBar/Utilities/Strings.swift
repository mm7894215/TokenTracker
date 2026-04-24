import Foundation

enum Strings {
    private static var zh: Bool { NativeLocalization.usesChinese }
    private static func t(_ en: String, _ zhCN: String) -> String { zh ? zhCN : en }

    static var appTitle: String { "TokenTracker" }
    static var serverUnavailable: String { t("Server Unavailable", "服务器不可用") }
    static var serverStarting: String { t("Starting TokenTracker", "正在启动 TokenTracker") }
    static var serverPreparing: String { t("This usually takes a few seconds.", "通常只需要几秒钟。") }
    static var loadingData: String { t("Loading data…", "正在加载数据…") }
    static var noData: String { t("No data", "暂无数据") }
    static var retryButton: String { t("Retry", "重试") }
    static var openDashboard: String { t("Open Dashboard", "打开仪表盘") }
    static var quitButton: String { t("Quit", "退出") }
    static var justNow: String { t("just now", "刚刚") }
    static var activityTitle: String { t("Activity", "活跃度") }
    static var trendTitle: String { t("Trend", "趋势") }
    static var topModelsTitle: String { t("Models", "模型") }
    static var modelBreakdownTitle: String { t("Model Breakdown", "模型明细") }
    static var todayTitle: String { t("Today", "今日") }
    static var sevenDayTitle: String { t("7-Day", "7 天") }
    static var thirtyDayTitle: String { t("30-Day", "30 天") }
    static var perDay: String { t("/day", "/天") }
    static var hintTrend: String { t("Usage trend appears after your first AI session", "首次 AI 会话后会显示使用趋势") }
    static var hintBreakdown: String { t("Model data appears after your first AI session", "首次 AI 会话后会显示模型数据") }
    static var periodTotal: String { t("Period", "周期") }
    static var conversations: String { t("conversations", "次对话") }
    static var totalTitle: String { t("Total", "总计") }
    static var hintModels: String { t("Model data appears after your first AI session", "首次 AI 会话后会显示模型数据") }
    static var serverStartingSubtitle: String { t("Starting local server…", "正在启动本地服务…") }
    static var serverStartingHint: String { t("This usually takes a few seconds.", "通常只需要几秒钟。") }
    static var serverOfflineHint: String {
        t("Check that tokentracker-cli is installed and try again.", "请检查 tokentracker-cli 是否已安装，然后重试。")
    }

    static var usageLimitsTitle: String { t("Limits", "限额") }
    static var sessionExpired: String { t("Session expired", "会话已过期") }
    static var allProvidersHidden: String { t("All providers hidden", "所有提供方均已隐藏") }
    static var cursorPlanLabel: String { t("Plan", "套餐") }
    static var cursorAutoLabel: String { t("Auto", "自动") }
    static var kiroMonthLabel: String { t("Month", "本月") }
    static var kiroBonusLabel: String { t("Bonus", "奖励") }
    static var limitResetNow: String { t("now", "现在") }

    static var periodDayLabel: String { t("Day", "日") }
    static var periodWeekLabel: String { t("Week", "周") }
    static var periodMonthLabel: String { t("Month", "月") }
    static var periodTotalLabel: String { t("Total", "总计") }

    static func topModelAccessibility(name: String, source: String, tokens: String, percent: String) -> String {
        zh
            ? "\(name)，\(source)，\(tokens) tokens，\(percent)"
            : "\(name), \(source), \(tokens) tokens, \(percent) percent"
    }
    static var syncingUsageData: String { t("Syncing usage data…", "正在同步使用数据…") }
    static var syncingFirstLaunchHint: String { t("First launch may take a moment", "首次启动可能需要一点时间") }
    static var limitsDisplayTitle: String { t("Limit Display", "限额显示") }

    static var menuSyncNow: String { t("Sync Now", "立即同步") }
    static var menuCheckForUpdates: String { t("Check for Updates…", "检查更新…") }
    static var menuLaunchAtLogin: String { t("Launch at Login", "登录时启动") }
    static var menuStarOnGitHub: String { t("★ Star on GitHub", "★ 在 GitHub 上标星") }
    static var menuShowStats: String { t("Show Stats in Menu Bar", "在菜单栏显示统计") }
    static var menuAnimatedIcon: String { t("Animated Icon", "动态图标") }
    static var menuSettings: String { t("Settings", "设置") }
    // Status-bar inline label (Tokens / Cost) always stays English — it sits
    // next to the menu bar number and should not swap with system language.
    static var menuTokenLabel: String { "Tokens" }
    static var menuCostLabel: String { "Cost" }
    static var tokensUnit: String { t("tokens", "tokens") }
    static var heatmapLegendLess: String { t("Less", "少") }
    static var heatmapLegendMore: String { t("More", "多") }
    static var trendAccessibilityLabel: String { t("Token usage trend chart", "Token 使用趋势图") }
    static var syncUsageData: String { t("Sync usage data", "同步使用数据") }
    static var addWidgetsTitle: String { t("Add TokenTracker widgets", "添加 TokenTracker 小组件") }
    static var addWidgetsMessage: String {
        t(
            "Right-click an empty area of your desktop, choose \"Edit Widgets\", then search for \"TokenTracker\" in the gallery.",
            "右键点击桌面空白处，选择“编辑小组件”，然后在小组件库中搜索“TokenTracker”。"
        )
    }
    static var gotItButton: String { t("Got it", "知道了") }

    static var serverNotAvailableMessage: String {
        t(
            "TokenTracker server not available.\nPlease reinstall the app or install: npm install -g tokentracker-cli",
            "TokenTracker 服务不可用。\n请重新安装应用，或运行：npm install -g tokentracker-cli"
        )
    }
    static func serverNotResponding(port: Int) -> String {
        t("Server started but not responding on port \(port).", "服务已启动，但端口 \(port) 无响应。")
    }
    static var serverExitedUnexpectedly: String { t("Server process exited unexpectedly.", "服务进程意外退出。") }
    static func embeddedServerLaunchFailed(_ error: String) -> String {
        t("Failed to launch embedded server: \(error)", "启动内置服务失败：\(error)")
    }
    static func serverLaunchFailed(_ error: String) -> String {
        t("Failed to launch server: \(error)", "启动服务失败：\(error)")
    }
    static var serverBecameUnreachable: String { t("Server became unreachable.", "服务已不可访问。") }

    static var updateChecking: String { t("Checking for updates...", "正在检查更新...") }
    static func updateSkipped(target: String, current: String) -> String {
        t(
            "Auto-update skipped: \(target) reports as \(current). Reinstall manually.",
            "已跳过自动更新：\(target) 显示为 \(current)。请手动重新安装。"
        )
    }
    static var upToDateTitle: String { t("You're Up to Date", "已是最新版本") }
    static func upToDateMessage(_ version: String) -> String {
        t("Version \(version) is the latest version.", "\(version) 已是最新版本。")
    }
    static var updateCheckFailedTitle: String { t("Update Check Failed", "检查更新失败") }
    static var manualCheckHint: String { t("You can also check manually:", "你也可以手动检查：") }
    static func newVersionTitle(_ version: String) -> String {
        t("New Version Available — \(version)", "发现新版本 — \(version)")
    }
    static var downloadInstallButton: String { t("Download & Install", "下载并安装") }
    static var viewOnGitHubButton: String { t("View on GitHub", "在 GitHub 查看") }
    static var laterButton: String { t("Later", "稍后") }
    static func updateCurrentLine(current: String, target: String) -> String {
        t("Current: \(current) → \(target)", "当前版本：\(current) → \(target)")
    }
    static var releaseNotesTitle: String { t("Release Notes:", "更新说明：") }
    static func updateSize(_ size: String) -> String { t("Size: \(size) MB", "大小：\(size) MB") }
    static var downloadFailedTitle: String { t("Download Failed", "下载失败") }
    static var invalidDownloadURL: String {
        t("Invalid download URL.\n\nYou can download manually from the Releases page.", "下载 URL 无效。\n\n你可以从 Releases 页面手动下载。")
    }
    static var manualDownloadHint: String {
        t("You can download manually from the Releases page.", "你可以从 Releases 页面手动下载。")
    }
    static var downloadingUnknown: String { t("Downloading…", "正在下载…") }
    static func downloadingPercent(_ pct: Int) -> String { t("Downloading \(pct)%...", "正在下载 \(pct)%...") }
    static func downloadingProgress(pct: Int, receivedMB: String, totalMB: String) -> String {
        t("Downloading \(pct)% (\(receivedMB)/\(totalMB) MB)", "正在下载 \(pct)%（\(receivedMB)/\(totalMB) MB）")
    }
    static var installing: String { t("Installing...", "正在安装...") }
    static var restarting: String { t("Restarting...", "正在重启...") }
    static var installationFailedTitle: String { t("Installation Failed", "安装失败") }
    static var manualInstallHint: String {
        t("Please drag TokenTrackerBar into Applications manually.", "请手动将 TokenTrackerBar 拖入“应用程序”。")
    }
    static var updateCompleteTitle: String { t("Update Complete", "更新完成") }
    static var updateCompleteMessage: String {
        t("New version installed to /Applications. Please restart manually.", "新版本已安装到 /Applications。请手动重启。")
    }
    static var openReleasesPageButton: String { t("Open Releases Page", "打开 Releases 页面") }
    static var okButton: String { t("OK", "好") }
    static func networkRequestFailed(code: Int) -> String {
        t("Network request failed (HTTP \(code)). Check your connection or proxy settings.", "网络请求失败（HTTP \(code)）。请检查网络连接或代理设置。")
    }
    static var emptyServerResponse: String { t("Server returned an empty response.", "服务器返回了空响应。") }
    static var fileDownloadFailed: String { t("File download failed. This may be a network issue.", "文件下载失败，可能是网络问题。") }
    static func installFailed(_ reason: String) -> String { t("Installation failed: \(reason)", "安装失败：\(reason)") }
    static var noReleaseAvailable: String { t("No release available.", "暂无可用发布版本。") }

    static func minutesAgo(_ n: Int) -> String { zh ? "\(n) 分钟前" : "\(n)m ago" }
    static func hoursAgo(_ n: Int) -> String { zh ? "\(n) 小时前" : "\(n)h ago" }
    static func daysAgo(_ n: Int) -> String { zh ? "\(n) 天前" : "\(n)d ago" }
    static func activeDays(_ n: Int) -> String { zh ? "\(n) 个活跃日" : "\(n) active days" }
    static func activeDaysThisWeek(_ n: Int) -> String { zh ? "本周 \(n) 个活跃日" : "\(n) active days this week" }
    static func tokensToday(_ tokens: String) -> String { zh ? "📊 今日：\(tokens) tokens" : "📊 Today: \(tokens) tokens" }
    static func tokensSpentToday(tokens: String, cost: String) -> String {
        zh ? "📈 今日 \(tokens) tokens，花费 \(cost)" : "📈 \(tokens) tokens — \(cost) spent today"
    }
    static func aiInvestedToday(_ cost: String) -> String { zh ? "💰 今日 AI 投入：\(cost)" : "💰 \(cost) invested in AI so far" }
    static func billToday(cost: String, tokens: String) -> String {
        zh ? "🧾 今日账单：\(cost)，\(tokens) tokens" : "🧾 Today's bill: \(cost) for \(tokens) tokens"
    }
    static func aiTabToday(_ cost: String) -> String { zh ? "💳 今日 AI 账单：\(cost)" : "💳 AI tab today: \(cost)" }
    static func sevenDayTotal(_ tokens: String) -> String { zh ? "📅 7 天总计：\(tokens) tokens" : "📅 7-day total: \(tokens) tokens" }
    static var perfectStreak: String { t("🏆 7/7 active days — perfect streak!", "🏆 7/7 活跃日，完美连续！") }
    static func thirtyDayTotal(_ tokens: String) -> String { zh ? "📆 30 天总计：\(tokens) tokens" : "📆 30-day total: \(tokens) tokens" }
    static func averagingPerDay(_ tokens: String) -> String { zh ? "📊 本月平均约 \(tokens)/天" : "📊 Averaging ~\(tokens)/day this month" }
    static func streakDays(_ n: Int) -> String { zh ? "🔥 连续 \(n) 天！继续保持" : "🔥 \(n)-day streak! Keep it going" }
    static func activeDaysAllTime(_ n: Int) -> String { zh ? "📈 累计 \(n) 个活跃日！" : "📈 \(n) active days all-time!" }
    static func topModel(_ name: String, _ percent: String) -> String { zh ? "🥇 最常用模型：\(name)（\(percent)）" : "🥇 Top model: \(name) (\(percent))" }
    static func runnerUp(_ name: String, _ percent: String) -> String { zh ? "🥈 第二名：\(name)，\(percent)" : "🥈 Runner-up: \(name) at \(percent)" }
    static func modelCount(_ count: Int) -> String { zh ? "🧰 使用了 \(count) 个不同模型" : "🧰 Using \(count) different models" }
    static func multiToolSetup(_ names: String) -> String { zh ? "🔀 多工具组合：\(names)" : "🔀 Multi-tool setup: \(names)" }
    static func conversationsToday(_ count: Int) -> String {
        zh ? "💬 今日 \(count) 次对话" : "💬 \(count) conversation\(count == 1 ? "" : "s") today"
    }
    static func busyTalker(_ count: Int) -> String { zh ? "🗣️ \(count) 次聊天，今天很忙" : "🗣️ \(count) chats! Busy talker today" }

    static var syncingQuips: [String] {
        zh
            ? ["⏳ 正在计算数据...", "📡 正在获取最新数据！", "🔄 稍等，正在同步...", "🧮 正在统计 tokens~"]
            : ["⏳ Crunching numbers...", "📡 Fetching latest data!", "🔄 One moment, syncing...", "🧮 Counting your tokens~"]
    }
    static var emptyTodayQuips: [String] {
        zh
            ? ["😴 今天还没有 tokens", "💬 发起一次对话来唤醒我！", "🌙 今天暂时很安静...", "⌨️ 等待你的第一个 prompt", "💤 Zzz... 还没有可统计内容", "🌅 风暴前的平静？", "✨ 我已经准备好了！"]
            : ["😴 No tokens yet today", "💬 Start chatting to wake me up!", "🌙 Quiet day so far...", "⌨️ Waiting for your first prompt", "💤 Zzz... nothing to count", "🌅 The calm before the storm?", "✨ I'm ready when you are!"]
    }
    static var warmupQuips: [String] { zh ? ["☕ 刚刚热身！", "🌱 温和开局"] : ["☕ Just warming up!", "🌱 A gentle start"] }
    static var flowQuips: [String] { zh ? ["🎯 开始进入状态！", "💪 今天进展不错"] : ["🎯 Getting into the flow!", "💪 Solid progress today"] }
    static var busyQuips: [String] { zh ? ["🔥 今天很忙！", "⚡ 状态正佳！"] : ["🔥 Busy day!", "⚡ You're on a roll!"] }
    static var heavyQuips: [String] { zh ? ["🚀 今天用量很高！", "🖨️ Token 机器启动"] : ["🚀 Heavy usage today!", "🖨️ Token machine goes brrr"] }
    static var massiveQuips: [String] { zh ? ["🤯 今天用量爆表！", "🔥 Token 计数器燃起来了！"] : ["🤯 MASSIVE day!", "🔥 Token counter on fire!"] }
    static var personalityQuips: [String] {
        zh
            ? ["👆 点我查看更多！", "📋 我来帮你计数", "✨ 每个 token 都有故事", "🤝 你的 AI 花费伙伴", "👋 你好呀~"]
            : ["👆 Tap me for more!", "📋 I count so you don't have to", "✨ Every token tells a story", "🤝 Your AI spending buddy", "👋 Hey there~"]
    }

    static func limitAccessibility(toolName: String, label: String, percent: Int, reset: String?) -> String {
        let base = zh ? "\(toolName) \(label) 限额，\(percent)%" : "\(toolName) \(label) limit, \(percent)%"
        guard let reset else { return base }
        return zh ? "\(base)，\(reset) 后重置" : "\(base), resets in \(reset)"
    }
}
