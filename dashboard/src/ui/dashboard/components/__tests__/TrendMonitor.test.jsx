import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendMonitor, getTrendMonitorScale } from "../TrendMonitor.jsx";

describe("getTrendMonitorScale", () => {
  it("clips isolated outliers before deriving the chart max", () => {
    const scale = getTrendMonitorScale([80, 90, 95, 110, 120, 140, 10000]);

    expect(scale.rawMax).toBe(10000);
    expect(scale.effectiveMax).toBeLessThan(300);
    expect(scale.clippedValues.at(-1)).toBe(scale.effectiveMax);
    expect((scale.clippedValues[0] / scale.effectiveMax) * 100).toBeGreaterThan(30);
  });
});

describe("TrendMonitor", () => {
  it("keeps normal bars visible when a single day is an outlier", () => {
    const rows = [80, 90, 95, 110, 120, 140, 10000].map((value) => ({
      billable_total_tokens: value,
    }));

    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));

    expect(bars).toHaveLength(rows.length);
    expect(parseFloat(bars[0].parentElement?.style.height ?? "")).toBeGreaterThan(30);
    expect(parseFloat(bars.at(-1)?.parentElement?.style.height ?? "")).toBe(100);
    expect(bars[0].parentElement?.className).toContain("absolute");
    expect(bars[0].parentElement?.parentElement?.className).toContain("self-stretch");
  });
});
