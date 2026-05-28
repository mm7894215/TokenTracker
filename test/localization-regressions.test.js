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
  assert.ok(usageLimitsView.includes("Strings.limitResetNow"));
  assert.ok(!usageLimitsView.includes('NativeLocalization.usesChinese ? "奖励" : "Bonus"'));

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
