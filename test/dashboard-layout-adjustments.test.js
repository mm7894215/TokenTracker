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
const projectUsagePath = path.join(
  __dirname,
  "..",
  "dashboard",
  "src",
  "ui",
  "dashboard",
  "components",
  "ProjectUsagePanel.jsx",
);
function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("DashboardPage places TrendMonitor and heatmap in left column", () => {
  const src = readFile(viewPath);
  const leftStart = src.indexOf("lg:col-span-4");
  const rightStart = src.indexOf("lg:col-span-8", leftStart + 1);
  assert.ok(leftStart !== -1, "expected left column markup");
  assert.ok(rightStart !== -1, "expected right column markup");

  const leftColumn = src.slice(leftStart, rightStart);
  const trendIndex = leftColumn.indexOf("<TrendMonitor");
  const heatmapIndex = leftColumn.indexOf("{activityHeatmapBlock}");
  assert.ok(trendIndex !== -1, "expected TrendMonitor in left column");
  assert.ok(heatmapIndex !== -1, "expected heatmap block in left column");
});

test("DashboardPage right column contains UsageOverview", () => {
  const src = readFile(viewPath);
  const leftStart = src.indexOf("lg:col-span-4");
  const rightStart = src.indexOf("lg:col-span-8", leftStart + 1);
  assert.ok(leftStart !== -1, "expected left column markup");
  assert.ok(rightStart !== -1, "expected right column markup");

  const rightColumn = src.slice(rightStart);
  assert.ok(rightColumn.includes("<UsageOverview"), "expected UsageOverview in right column");
});

test("ProjectUsagePanel lays out cards in responsive grid", () => {
  const src = readFile(projectUsagePath);
  assert.ok(src.includes("grid-cols-1"), "expected project usage grid to start with one column");
  assert.ok(
    src.includes("md:grid-cols-2"),
    "expected project usage grid to use two columns on medium screens",
  );
  assert.ok(
    src.includes("lg:grid-cols-3"),
    "expected project usage grid to use three columns on large screens",
  );
});

test("ProjectUsagePanel formats star values compactly", () => {
  const src = readFile(projectUsagePath);
  assert.ok(
    src.includes("formatCompactNumber(starsRaw"),
    "expected project usage panel to compact star values",
  );
});

test("ProjectUsagePanel renders star and token info", () => {
  const src = readFile(projectUsagePath);
  assert.ok(src.includes("starsCompact"), "expected project usage card to show stars");
  assert.ok(src.includes("tokensCompact"), "expected project usage card to show tokens");
});

test("ProjectUsagePanel constrains identity text width", () => {
  const src = readFile(projectUsagePath);
  assert.ok(src.includes("truncate"), "expected truncated identity text");
  assert.ok(src.includes("min-w-0"), "expected min width constraint for identity text");
});

test("DashboardPage omits auth and install/download panels", () => {
  const containerSrc = readFile(containerPath);
  const viewSrc = readFile(viewPath);
  assert.ok(!containerSrc.includes("shouldShowInstallCard"), "expected install helper removed from dashboard");
  assert.ok(!containerSrc.includes("force_install"), "expected force install query handling removed");
  assert.ok(!containerSrc.includes("showAuthGate"), "expected auth gate removed from dashboard container");
  assert.ok(!viewSrc.includes("LoginCard"), "expected sign-in panel removed from dashboard view");
  assert.ok(!viewSrc.includes("MacAppBanner"), "expected download banner removed from dashboard view");
  assert.ok(!viewSrc.includes("shouldShowInstall ? ("), "expected install panel removed from dashboard view");
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
