import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = () => readFileSync(join(__dirname, "DashboardPage.jsx"), "utf8");

describe("DashboardPage period defaults", () => {
  it("starts normal dashboard loads on day", () => {
    expect(src()).toContain('const [selectedPeriod, setSelectedPeriod] = useState("day");');
  });

  it("keeps screenshot mode pinned to total", () => {
    expect(src()).toContain('const period = screenshotMode ? "total" : selectedPeriod;');
  });

  it("exposes dashboard periods in the expected order", () => {
    expect(src()).toContain('const PERIODS = ["day", "24h", "week", "month", "total", "custom"];');
  });

  it("treats 24h details as hourly and paged", () => {
    expect(src()).toContain('const DETAILS_PAGED_PERIODS = new Set(["day", "24h", "total", "custom"]);');
    expect(src()).toContain('if (period === "day" || period === "24h") return "hour";');
  });

  it("configures visible-only dashboard auto refresh outside screenshot mode", () => {
    const text = src();
    expect(text).toContain('const AUTO_REFRESH_STORAGE_KEY = "tt:dashboard-auto-refresh-ms";');
    expect(text).toContain("const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 30000;");
    expect(text).toContain('if (value == null || value === "") return DEFAULT_AUTO_REFRESH_INTERVAL_MS;');
    expect(text).toContain("{ value: 0, labelKey: \"usage.auto_refresh.off\" }");
    expect(text).toContain("{ value: 120000, labelKey: \"usage.auto_refresh.120s\" }");
    expect(text).toContain("const [autoRefreshIntervalMs, setAutoRefreshIntervalMs] = useState(readAutoRefreshInterval);");
    expect(text).toContain("const [dashboardNowMs, setDashboardNowMs] = useState(() => Date.now());");
    expect(text).toContain("const dashboardNow = useMemo(");
    expect(text).toContain("now: dashboardNow");
    expect(text).toContain("setDashboardNowMs(nowMs);");
    expect(text).toContain("const LOCAL_DAY_WATCH_INTERVAL_MS = 60000;");
    expect(text).toContain("lastLocalDayRef.current");
    expect(text).toContain("window.localStorage?.setItem(AUTO_REFRESH_STORAGE_KEY, String(nextInterval));");
    expect(text).toContain("if (autoRefreshIntervalMs <= 0) return undefined;");
    expect(text).toContain("const handleManualRefresh = useCallback(async () => {");
    expect(text).toContain("const handleAutoRefresh = useCallback(async () => {");
    expect(text).toContain("function didLocalSyncQueueBuckets(result) {");
    expect(text).toContain("New 30-min buckets queued:");
    expect(text).toContain("await triggerLocalSync();");
    expect(text).toContain("await handleAutoRefresh();");
    expect(text).toContain("refreshAll={handleManualRefresh}");
    expect(text).toContain('if (screenshotMode || typeof window === "undefined") return undefined;');
    expect(text).toContain('document.visibilityState === "visible"');
    expect(text).toContain("autoRefreshInFlightRef.current");
    expect(text).toContain("}, autoRefreshIntervalMs);");
  });

  it("starts local sync in the background during auto refresh", () => {
    const text = src();
    const autoSyncStart = text.indexOf("const startAutoSync = useCallback");
    const autoStart = text.indexOf("const handleAutoRefresh = useCallback");
    const optionsStart = text.indexOf("const handleAutoRefreshIntervalChange = useCallback");
    expect(autoSyncStart).toBeGreaterThan(-1);
    expect(autoStart).toBeGreaterThan(autoSyncStart);
    expect(optionsStart).toBeGreaterThan(autoStart);
    expect(text.slice(autoSyncStart, autoStart)).toContain("return triggerLocalSync()");
    expect(text.slice(autoSyncStart, autoStart)).toContain(".then(didLocalSyncQueueBuckets)");
    expect(text.slice(autoStart, optionsStart)).toContain("const syncPromise = startAutoSync();");
    expect(text.slice(autoStart, optionsStart)).toContain("await refreshAll();");
    expect(text.slice(autoStart, optionsStart)).toContain("return refreshAll();");
  });

  it("surfaces data-health copy for empty selected periods with recent usage", () => {
    const text = src();
    expect(text).toContain("dashboard.data_health.day_empty_has_recent");
    expect(text).toContain("dashboard.data_health.period_empty_has_30d");
    expect(text).toContain("dashboard.data_health.month_empty_has_30d");
    expect(text).toContain("dashboard.data_health.no_recent_data");
    expect(text).toContain("dataHealthMessage={dataHealthMessage}");
  });
});
