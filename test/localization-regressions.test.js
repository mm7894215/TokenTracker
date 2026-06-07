const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

test("zh locale keeps CLI subcommands executable", () => {
  const dashboardCopy = read("dashboard/src/content/i18n/zh/dashboard.json");

  assert.match(
    dashboardCopy,
    /"dashboard\.install\.cmd\.init":\s*"npx --yes tokentracker-cli init"/,
    "expected zh install init command to keep the init subcommand",
  );
  assert.match(
    dashboardCopy,
    /"dashboard\.install\.cmd\.sync":\s*"npx --yes tokentracker-cli sync"/,
    "expected zh sync command to keep the sync subcommand",
  );
  assert.doesNotMatch(dashboardCopy, /tokentracker-cli (初始化|同步)/);
});

test("native macOS strings are wired through the Swift localization helpers", () => {
  const nativeLocalization = read("TokenTrackerBar/Shared/NativeLocalization.swift");
  const strings = read("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift");
  const widgetStrings = read("TokenTrackerBar/TokenTrackerWidget/Views/WidgetStrings.swift");
  const dateHelpers = read("TokenTrackerBar/TokenTrackerBar/Utilities/DateHelpers.swift");
  const clawdCompanion = read("TokenTrackerBar/TokenTrackerBar/Views/ClawdCompanionView.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const topModelsView = read("TokenTrackerBar/TokenTrackerBar/Views/TopModelsView.swift");
  const summaryWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/SummaryWidget.swift");
  const heatmapWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/HeatmapWidget.swift");
  const topModelsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/TopModelsWidget.swift");
  const usageLimitsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/UsageLimitsWidget.swift");
  const sharedWidgetViews = read("TokenTrackerBar/TokenTrackerWidget/Views/SharedWidgetViews.swift");

  // NativeLocalization is the single source of truth for the current locale and
  // recognises all five supported locales (en, zh-CN, zh-TW, ja, ko).
  assert.ok(nativeLocalization.includes("public static var usesChinese: Bool"));
  assert.ok(nativeLocalization.includes("public static let chineseLocale = \"zh-CN\""));
  assert.ok(nativeLocalization.includes("public static let traditionalChineseLocale = \"zh-TW\""));
  assert.ok(nativeLocalization.includes("public static let japaneseLocale = \"ja\""));
  assert.ok(nativeLocalization.includes("public static let koreanLocale = \"ko\""));

  // Strings.swift goes through the t(en, zhCN, zhTW, ja, ko) helper bound to
  // NativeLocalization.currentResolvedLocale.
  assert.ok(strings.includes("NativeLocalization.currentResolvedLocale"));
  assert.ok(strings.includes('t("Server Unavailable", "服务器不可用", "伺服器不可用", "サーバーを利用できません", "서버를 사용할 수 없음")'));
  assert.ok(strings.includes('t("Sync Now", "立即同步", "立即同步", "今すぐ同期", "지금 동기화")'));
  assert.ok(strings.includes('t("Today", "今日", "今日", "今日", "오늘")'));
  assert.ok(strings.includes('t("Settings", "设置", "設定", "設定", "설정")'));
  // Menu-bar inline labels stay English on purpose — they sit next to the token
  // count so they should never swap with system language.
  assert.ok(strings.includes('static var menuTokenLabel: String { "Tokens" }'));
  assert.ok(strings.includes('static var menuCostLabel: String { "Cost" }'));

  // WidgetStrings mirrors the same helper for the WidgetKit target.
  assert.ok(widgetStrings.includes("NativeLocalization.currentResolvedLocale"));
  assert.ok(widgetStrings.includes('t("Usage", "使用情况", "使用情況", "使用状況", "사용량")'));
  assert.ok(widgetStrings.includes('t("Activity Heatmap", "活跃热力图", "活躍熱力圖", "アクティビティヒートマップ", "활동 히트맵")'));

  // DateHelpers / UsageLimitsView / TopModelsView must not re-implement the
  // en/zh branch inline — they must route through Strings.* so the copy table
  // stays centralised.
  assert.ok(dateHelpers.includes("return Strings.periodDayLabel"));
  assert.ok(dateHelpers.includes("return Strings.periodTotalLabel"));
  assert.ok(!dateHelpers.includes('NativeLocalization.usesChinese ? "日" : "Day"'));

  assert.ok(usageLimitsView.includes("Strings.kiroBonusLabel"));
  assert.ok(usageLimitsView.includes("Strings.grokMonthLabel"));
  assert.ok(usageLimitsView.includes('case "grok"'));
  assert.ok(usageLimitsView.includes("Strings.limitResetNow"));
  assert.ok(!usageLimitsView.includes('NativeLocalization.usesChinese ? "奖励" : "Bonus"'));

  const limitsSettingsStore = read("TokenTrackerBar/TokenTrackerBar/Models/LimitsSettingsStore.swift");
  assert.ok(limitsSettingsStore.includes('"grok"'));
  assert.ok(limitsSettingsStore.includes('"Grok Build"'));

  assert.ok(topModelsView.includes("Strings.topModelAccessibility"));

  // Clawd quips now pull from Strings rather than hardcoded English arrays.
  assert.ok(clawdCompanion.includes("Strings.syncingQuips"));
  assert.ok(clawdCompanion.includes("Strings.personalityQuips"));
  assert.ok(clawdCompanion.includes("Strings.tokensToday(f)"));

  // Widget entry points and shared chrome flow through WidgetStrings.
  assert.ok(summaryWidget.includes("WidgetStrings.usageName"));
  assert.ok(summaryWidget.includes("WidgetStrings.today"));
  assert.ok(summaryWidget.includes("WidgetStrings.vsYesterday"));
  assert.ok(heatmapWidget.includes("WidgetStrings.heatmapName"));
  assert.ok(heatmapWidget.includes("WidgetStrings.streak(streak)"));
  assert.ok(topModelsWidget.includes("WidgetStrings.topModelsName"));
  assert.ok(topModelsWidget.includes("WidgetStrings.noModelUsage"));
  assert.ok(usageLimitsWidget.includes("WidgetStrings.limitsName"));
  assert.ok(usageLimitsWidget.includes("WidgetStrings.noConfiguredProviders"));
  assert.ok(sharedWidgetViews.includes("WidgetStrings.updated(WidgetFormat.relativeUpdated(updated))"));
});

test("Codex Spark usage limits are wired through macOS consumers", () => {
  const model = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const widgetSnapshotWriter = read("TokenTrackerBar/TokenTrackerBar/Services/WidgetSnapshotWriter.swift");
  const statusBarController = read("TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift");
  const nativeBridge = read("TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift");

  assert.ok(model.includes("let sparkPrimaryWindow: CodexWindow?"));
  assert.ok(model.includes("let sparkSecondaryWindow: CodexWindow?"));
  assert.ok(model.includes('case sparkPrimaryWindow = "spark_primary_window"'));
  assert.ok(model.includes('case sparkSecondaryWindow = "spark_secondary_window"'));

  assert.match(usageLimitsView, /if let w = codex\.sparkPrimaryWindow \{\s*limitRow\(label: "5h \(Spark\)"/);
  assert.match(usageLimitsView, /if let w = codex\.sparkSecondaryWindow \{\s*limitRow\(label: "7d \(Spark\)"/);

  assert.match(widgetSnapshotWriter, /if let w = limits\.codex\.sparkPrimaryWindow \{\s*out\.append\(LimitProvider\([^)]*label: "Codex · 5h \(Spark\)"/);
  assert.match(widgetSnapshotWriter, /if let w = limits\.codex\.sparkSecondaryWindow \{\s*out\.append\(LimitProvider\([^)]*label: "Codex · weekly \(Spark\)"/);

  assert.ok(statusBarController.includes("case codexSpark5h"));
  assert.ok(statusBarController.includes("case codexSpark7d"));
  assert.ok(statusBarController.includes('case .codexSpark5h: return "Cx Sp 5h"'));
  assert.ok(statusBarController.includes('case .codexSpark7d: return "Cx Sp 7d"'));
  assert.ok(statusBarController.includes('case .codexSpark5h: return "Codex Spark 5h Limit"'));
  assert.ok(statusBarController.includes('case .codexSpark7d: return "Codex Spark 7d Limit"'));
  assert.match(statusBarController, /case \.codex5h,\s*\.codex7d,\s*\.codexSpark5h,\s*\.codexSpark7d:\s*return "codex"/);
  assert.match(statusBarController, /case \.codexSpark5h:\s*return codex\.sparkPrimaryWindow != nil/);
  assert.match(statusBarController, /case \.codexSpark7d:\s*return codex\.sparkSecondaryWindow != nil/);
  assert.ok(statusBarController.includes("limits.isProviderAvailable(provider) && limits.hasData(for: metric)"));
  assert.match(statusBarController, /guard let limits else \{\s*return false\s*\}/);
  assert.match(statusBarController, /case \.codexSpark5h:\s*guard let window = viewModel\.usageLimits\?\.codex\.sparkPrimaryWindow,/);
  assert.match(statusBarController, /case \.codexSpark7d:\s*guard let window = viewModel\.usageLimits\?\.codex\.sparkSecondaryWindow,/);

  assert.doesNotMatch(nativeBridge, /sparkPrimaryWindow|sparkSecondaryWindow|codexSpark/i);
});

test("locale PR stays scoped away from silent auto update flags", () => {
  const app = read("TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift");
  const plist = read("TokenTrackerBar/TokenTrackerBar/Info.plist");
  const project = read("TokenTrackerBar/project.yml");

  assert.ok(app.includes("UpdateChecker.shared.check(silent: true)"));
  assert.doesNotMatch(app, /TokenTrackerEnableSilentAutoUpdate|isSilentAutoUpdateEnabled/);
  assert.doesNotMatch(plist, /TokenTrackerEnableSilentAutoUpdate/);
  assert.doesNotMatch(project, /TokenTrackerEnableSilentAutoUpdate/);
});

test("zh locale uses reviewed natural copy for settings and dashboard", () => {
  const core = read("dashboard/src/content/i18n/zh/core.json");
  const dashboard = read("dashboard/src/content/i18n/zh/dashboard.json");

  assert.match(core, /"identity_card\.rank_label":\s*"排名"/);
  assert.match(core, /"widgets\.heatmap\.description":\s*"像 GitHub 一样，一眼看清活跃和空闲的日子。"/);
  assert.match(core, /"widgets\.topModels\.name":\s*"热门模型"/);
  assert.match(core, /"daily\.sort\.conversations\.label":\s*"对话数"/);
  assert.match(core, /"settings\.account\.githubUrl":\s*"GitHub 主页"/);
  assert.match(dashboard, /"dashboard\.screenshot\.title_line2":\s*"2025 年度回顾"/);

  assert.doesNotMatch(core, /顶级模特|转化次数|InsForge 可以摄取您的队列|斑点条纹和安静的日子一目了然/);
  assert.doesNotMatch(dashboard, /型号分解|动态的|复制的|编码剂|2025 包裹/);
});
