const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const containerPath = path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx");
const viewPath = path.join(
  __dirname,
  "..",
  "dashboard",
  "src",
  "ui",
  "dashboard",
  "views",
  "DashboardView.jsx",
);
const copyPath = path.join(__dirname, "..", "dashboard", "src", "content", "copy.csv");
const dataDetailsPath = path.join(
  __dirname,
  "..",
  "dashboard",
  "src",
  "ui",
  "dashboard",
  "components",
  "DataDetails.jsx",
);
const projectDetailModalPath = path.join(
  __dirname,
  "..",
  "dashboard",
  "src",
  "ui",
  "dashboard",
  "components",
  "ProjectDetailModal.jsx",
);
const installStatusPath = path.join(
  __dirname,
  "..",
  "dashboard",
  "src",
  "lib",
  "install-status.js",
);

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("DashboardPage places TrendMonitor and heatmap in left column", () => {
  const src = readFile(viewPath);
  const leftRendererStart = src.indexOf("function renderLeftCard");
  const rightRendererStart = src.indexOf("function renderRightCard", leftRendererStart + 1);
  assert.ok(leftRendererStart !== -1, "expected left card renderer");
  assert.ok(rightRendererStart !== -1, "expected right card renderer");

  const leftRenderer = src.slice(leftRendererStart, rightRendererStart);
  const trendIndex = leftRenderer.indexOf("<TrendMonitor");
  const heatmapIndex = leftRenderer.indexOf("{activityHeatmapBlock}");
  assert.ok(trendIndex !== -1, "expected TrendMonitor in left column");
  assert.ok(heatmapIndex !== -1, "expected heatmap block in left column");
});

test("DashboardPage right column contains UsageOverview", () => {
  const src = readFile(viewPath);
  const rightRendererStart = src.indexOf("function renderRightCard");
  const sortableRendererStart = src.indexOf("function renderSortableColumn", rightRendererStart + 1);
  assert.ok(rightRendererStart !== -1, "expected right card renderer");
  assert.ok(sortableRendererStart !== -1, "expected sortable column renderer");

  const rightRenderer = src.slice(rightRendererStart, sortableRendererStart);
  assert.ok(rightRenderer.includes("<UsageOverview"), "expected UsageOverview in right column");
});

test("DataDetails project rows open the drill-down modal instead of navigating", () => {
  const src = readFile(dataDetailsPath);
  assert.ok(src.includes("<ProjectDetailModal"), "expected project detail modal wiring");
  assert.ok(src.includes("onSelect?.(entry)"), "expected project row click to select entry");
  assert.ok(
    !src.includes("target=\"_blank\""),
    "project rows must not navigate to external project URLs",
  );
});

test("DataDetails project rows honor the global token format, sources and share bar", () => {
  const src = readFile(dataDetailsPath);
  assert.ok(src.includes("formatTokens(tokensRaw)"), "expected global token formatting");
  assert.ok(src.includes("formatTokensTooltip(tokensRaw)"), "expected exact hover details");
  assert.ok(src.includes("<ProviderIcon"), "expected per-source provider icons");
  assert.ok(src.includes("maxTokens"), "expected share bar scaled to top project");
  assert.ok(src.includes("truncate"), "expected truncated project names");
  assert.ok(src.includes("min-w-0"), "expected min width constraint for project names");
});

test("ProjectDetailModal renders inline (no body portal) and stays local", () => {
  const src = readFile(projectDetailModalPath);
  assert.ok(!src.includes("createPortal("), "modal must render inline for Windows WebView2");
  assert.ok(
    !src.includes("api.github.com"),
    "modal must not call external APIs — local data only",
  );
  assert.ok(src.includes("useProjectUsageDetail"), "expected drill-down data hook");
});

test("DashboardPage wires install panel gating through helper", () => {
  const containerSrc = readFile(containerPath);
  const installStatusSrc = readFile(installStatusPath);
  const viewSrc = readFile(viewPath);
  assert.ok(containerSrc.includes("shouldShowInstallCard"), "expected install status helper usage");
  assert.ok(
    containerSrc.includes("has_active_device_token"),
    "expected snake_case install token field usage",
  );
  assert.ok(containerSrc.includes("hasActiveDeviceToken"), "expected camelCase fallback usage");
  assert.ok(
    containerSrc.includes("const shouldShowInstall = shouldShowInstallCard({"),
    "expected helper-based install gate assignment",
  );
  assert.ok(
    installStatusSrc.includes("publicMode || screenshotMode"),
    "expected helper to hide in public/screenshot mode",
  );
  assert.ok(
    installStatusSrc.includes("if (forceInstall) return true"),
    "expected helper to honor forceInstall",
  );
  assert.ok(installStatusSrc.includes("accessEnabled"), "expected helper to check accessEnabled");
  assert.ok(
    installStatusSrc.includes("!heatmapLoading"),
    "expected helper to check heatmapLoading",
  );
  assert.ok(installStatusSrc.includes("activeDays === 0"), "expected helper to gate on activeDays");
  assert.ok(
    installStatusSrc.includes("!hasActiveDeviceToken"),
    "expected helper to hide card for active device token",
  );
  assert.ok(
    viewSrc.includes("installCopy: shouldShowInstall"),
    "expected install panel to use shouldShowInstall",
  );
  assert.ok(viewSrc.includes('case "installCopy"'), "expected install panel card renderer");
});

test("DashboardView does not prune async quality-per-dollar while loading", () => {
  const src = readFile(viewPath);
  assert.match(
    src,
    /EMPTY_PRUNABLE_CARD_IDS\s*=\s*new Set\(\[\s*"macAppBanner",\s*"widgetOnboarding"\s*\]\)/,
    "expected only permanently dismissible cards to be pruned when empty",
  );
  assert.ok(src.includes("if (!EMPTY_PRUNABLE_CARD_IDS.has(id)) return"));
  assert.doesNotMatch(
    src,
    /EMPTY_PRUNABLE_CARD_IDS\s*=\s*new Set\([^)]*"qualityPerDollar"/,
    "quality-per-dollar can be empty while async outcomes data loads",
  );
});

test("DashboardPage only uses the full skeleton before dashboard content is first shown", () => {
  const src = readFile(containerPath);
  assert.ok(
    src.includes("const [dashboardContentShown, setDashboardContentShown] = useState(false)"),
    "expected a one-way latch for the first dashboard render",
  );
  assert.match(
    src,
    /const initialDashboardLoading\s*=\s*!dashboardContentShown\s*&&/,
    "later period refreshes must not restore the full-page skeleton",
  );
  assert.ok(
    src.includes("setDashboardContentShown(true)"),
    "expected the latch to be set after dashboard content is visible",
  );
});

test("DashboardPage removes heatmap range label", () => {
  const src = readFile(viewPath);
  assert.ok(!src.includes("dashboard.activity.range"), "expected heatmap range label removed");
});

test("copy registry removes unused install steps and range label", () => {
  const csv = readFile(copyPath);
  const removed = [
    "dashboard.install.headline",
    "dashboard.install.step1",
    "dashboard.install.step2",
    "dashboard.install.step3",
    "dashboard.activity.range",
  ];
  for (const key of removed) {
    assert.ok(!csv.includes(key), `expected copy key removed: ${key}`);
  }
});

test("DashboardPage lets TrendMonitor auto-size", () => {
  const src = readFile(viewPath);
  assert.ok(!src.includes('className="min-h-[240px]"'), "expected TrendMonitor min height removed");
  assert.ok(src.includes("<TrendMonitor"), "expected TrendMonitor to be rendered");
});

test("TrendMonitor root does not force full height", () => {
  const src = readFile(
    path.join(
      __dirname,
      "..",
      "dashboard",
      "src",
      "ui",
      "dashboard",
      "components",
      "TrendMonitor.jsx",
    ),
  );
  assert.ok(src.includes("export function TrendMonitor"), "expected TrendMonitor component");
  const lines = src.split("\n");
  const rootLine = lines.find((line) => line.includes('"rounded-xl border border-oai-gray-200'));
  assert.ok(rootLine, "expected TrendMonitor root className line");
  assert.ok(!rootLine.includes("h-full"), "expected TrendMonitor root to avoid h-full");
});

test("DashboardPage supports force_install preview", () => {
  const src = readFile(containerPath);
  assert.ok(src.includes("force_install"), "expected force_install query param support");
  assert.ok(
    src.includes("isProductionHost"),
    "expected force_install gated by production host check",
  );
  assert.ok(
    src.includes("forceInstall"),
    "expected forceInstall flag to influence install visibility",
  );
});

test("DashboardPage removes the obsolete responsive summary format state", () => {
  const src = readFile(containerPath);
  assert.ok(!src.includes("setCompactSummary"), "obsolete summary setter must not survive state removal");
  assert.ok(!src.includes("compactSummary"), "obsolete summary state must not survive global formatting");
  assert.ok(
    src.includes("const summaryValue = formatTokens(summaryTotalTokens)"),
    "dashboard hero total must follow the global token format setting",
  );
  assert.ok(
    src.includes("onToggleSummaryFormat={toggleSummaryFormat}"),
    "dashboard hero click must toggle the global token format setting",
  );
  assert.ok(
    src.includes("setTokenFormatMode("),
    "dashboard hero click must persist through the shared token format provider",
  );
});
