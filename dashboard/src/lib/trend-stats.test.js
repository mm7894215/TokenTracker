import { describe, expect, it } from "vitest";
import {
  computeZoomStats,
  formatBucketRange,
  formatTickLabel,
  formatTrendRange,
  getTrendInsightKey,
  granularityFromPeriod,
} from "./trend-stats";

describe("granularityFromPeriod", () => {
  it("maps period to trend granularity (mirrors use-trend-data mode)", () => {
    expect(granularityFromPeriod("day")).toBe("hourly");
    expect(granularityFromPeriod("total")).toBe("monthly");
    expect(granularityFromPeriod("week")).toBe("daily");
    expect(granularityFromPeriod("month")).toBe("daily");
    expect(granularityFromPeriod("custom")).toBe("daily");
  });
});

describe("computeZoomStats", () => {
  it("sums tokens / billable / conversations / cost over observed buckets", () => {
    const rows = [
      { day: "2026-05-01", total_tokens: 100, billable_total_tokens: 80, total_cost_usd: 1, conversation_count: 2 },
      { day: "2026-05-02", total_tokens: 300, billable_total_tokens: 200, total_cost_usd: 3, conversation_count: 5 },
    ];
    const s = computeZoomStats(rows);
    expect(s.totalTokens).toBe(400);
    expect(s.billableTokens).toBe(280);
    expect(s.totalCostUsd).toBe(4);
    expect(s.conversationCount).toBe(7);
    expect(s.bucketCount).toBe(2);
    expect(s.activeBuckets).toBe(2);
    expect(s.peak).toEqual({ value: 200, label: "2026-05-02" });
  });

  it("returns null cost when no row carries cost data (avoid misleading $0)", () => {
    const rows = [{ day: "2026-05-01", total_tokens: 100, billable_total_tokens: 100 }];
    expect(computeZoomStats(rows).totalCostUsd).toBeNull();
  });

  it("ignores missing/future rows", () => {
    const rows = [
      { day: "2026-05-01", total_tokens: 100, billable_total_tokens: 100, total_cost_usd: 1 },
      { day: "2026-05-02", missing: true, total_tokens: 999 },
      { day: "2026-05-03", future: true, total_tokens: 999 },
    ];
    const s = computeZoomStats(rows);
    expect(s.totalTokens).toBe(100);
    expect(s.bucketCount).toBe(1);
    expect(s.totalCostUsd).toBe(1);
  });

  it("handles empty / non-array input", () => {
    expect(computeZoomStats([]).totalTokens).toBe(0);
    expect(computeZoomStats(null).peak).toBeNull();
    expect(computeZoomStats(undefined).totalCostUsd).toBeNull();
  });
});

describe("formatBucketRange", () => {
  it("hourly -> 30-min range with end = start + 30min", () => {
    expect(formatBucketRange({ hour: "2026-05-29T14:00:00" }, "hourly", "en-US")).toBe("May 29, 2026 14:00–14:30");
    expect(formatBucketRange({ hour: "2026-05-29T14:30:00" }, "hourly", "zh-CN")).toBe("2026年5月29日 14:30–15:00");
  });

  it("hourly makes a midnight rollover explicit", () => {
    expect(formatBucketRange({ hour: "2026-05-29T23:30:00" }, "hourly", "en-US")).toBe("May 29, 2026 23:30–May 30, 2026 00:00");
  });

  it("localizes daily and monthly bucket keys", () => {
    expect(formatBucketRange({ day: "2026-05-29" }, "daily", "en-US")).toBe("May 29, 2026");
    expect(formatBucketRange({ month: "2026-05" }, "monthly", "zh-CN")).toBe("2026年5月");
  });

  it("falls back to raw label for unparseable / missing input", () => {
    expect(formatBucketRange({ hour: "garbage" }, "hourly")).toBe("garbage");
    expect(formatBucketRange(null, "hourly")).toBe("");
  });
});

describe("formatTrendRange", () => {
  it("shows an hourly day once with readable endpoints", () => {
    expect(formatTrendRange("2026-05-29", "2026-05-29", "hourly", "zh-CN")).toEqual({
      start: "2026年5月29日 · 00:00",
      end: "24:00",
    });
  });

  it("localizes daily and monthly range endpoints", () => {
    expect(formatTrendRange("2026-05-01", "2026-05-29", "daily", "en-US")).toEqual({
      start: "May 1, 2026",
      end: "May 29, 2026",
    });
    expect(formatTrendRange("2026-01", "2026-05", "monthly", "zh-CN")).toEqual({
      start: "2026年1月",
      end: "2026年5月",
    });
  });
});

describe("getTrendInsightKey", () => {
  it("returns the empty key when no buckets are active", () => {
    expect(getTrendInsightKey({ activeBuckets: 0 })).toBe("trend.zoom.insight.empty");
    expect(getTrendInsightKey(null)).toBe("trend.zoom.insight.empty");
  });

  it("tiers the insight by total volume", () => {
    expect(getTrendInsightKey({ activeBuckets: 3, totalTokens: 5_000_000 })).toBe("trend.zoom.insight.calm");
    expect(getTrendInsightKey({ activeBuckets: 3, totalTokens: 100_000_000 })).toBe("trend.zoom.insight.steady");
    expect(getTrendInsightKey({ activeBuckets: 3, totalTokens: 1_000_000_000 })).toBe("trend.zoom.insight.heavy");
    expect(getTrendInsightKey({ activeBuckets: 3, totalTokens: 10_000_000_000 })).toBe("trend.zoom.insight.massive");
  });
});

describe("formatTickLabel", () => {
  it("emits short localized labels per granularity", () => {
    expect(formatTickLabel({ hour: "2026-05-29T14:30:00" }, "hourly", "zh-CN")).toBe("14:30");
    expect(formatTickLabel({ day: "2026-05-29" }, "daily", "zh-CN")).toBe("5月29日");
    expect(formatTickLabel({ month: "2026-05" }, "monthly", "en-US")).toBe("May 2026");
  });

  it("returns empty string for null row", () => {
    expect(formatTickLabel(null, "daily")).toBe("");
  });
});
