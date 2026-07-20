import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The zoom modal pulls in use-trend-data (a .ts hook imported with a .js
// specifier) which vitest's resolver can't follow the way the Vite build does.
// The small-card tests never open the modal, so stub it out.
vi.mock("../TrendMonitorZoomModal", () => ({ TrendMonitorZoomModal: () => null }));

import {
  TrendMonitor,
  computeInterpolatedSeries,
  getTrendMonitorScale,
} from "../TrendMonitor.jsx";

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

  it("renders real-zero observations as flat baseline bars, not interpolated", () => {
    // Two real values bracketing a real zero: the zero must NOT be filled in.
    const rows = [
      { billable_total_tokens: 100 },
      { billable_total_tokens: 0 },
      { billable_total_tokens: 100 },
    ];
    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));
    expect(bars).toHaveLength(3);
    // Real-zero gets the baseline pixel height, not a percentage interpolation.
    expect(bars[1].parentElement?.style.height).toBe("2px");
  });

  it("renders future bars as striped estimates with an always-visible legend", () => {
    const rows = [
      { billable_total_tokens: 100 },
      { billable_total_tokens: 100 },
      { future: true },
    ];
    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));
    const previewBar = bars.at(-1);
    expect(previewBar?.dataset.trendKind).toBe("predicted");
    expect(previewBar?.style.opacity).toBe("0.55");
    expect(previewBar?.style.backgroundImage).toContain("repeating-linear-gradient");
    expect(container.querySelector('[data-trend-prediction-legend="true"]')?.textContent).toContain(
      "~ Estimated",
    );
    // Predicted heights are clipped to the y-axis max and rendered as a percentage.
    expect(previewBar?.parentElement?.style.height).toMatch(/%$/);
  });

  it("does not show the estimate legend when the range has no future rows", () => {
    const { container } = render(
      <TrendMonitor rows={[{ billable_total_tokens: 100 }]} showTimeZoneLabel={false} />,
    );

    expect(container.querySelector('[data-trend-prediction-legend="true"]')).toBeNull();
  });

  it("renders X-axis tick labels only in zoom mode (small card unchanged)", () => {
    const rows = [
      { hour: "2026-05-29T14:00:00", billable_total_tokens: 100 },
      { hour: "2026-05-29T14:30:00", billable_total_tokens: 200 },
    ];

    const plain = render(<TrendMonitor rows={rows} period="day" showTimeZoneLabel={false} />);
    expect(plain.container.textContent).not.toContain("14:00");

    const zoomed = render(
      <TrendMonitor rows={rows} period="day" isZoom showTimeZoneLabel={false} />,
    );
    expect(zoomed.container.textContent).toContain("14:00");
    expect(zoomed.container.textContent).toContain("14:30");
  });

  it("shows the maximize button only when zoomConfig is provided", () => {
    const rows = [{ billable_total_tokens: 100 }];

    const without = render(<TrendMonitor rows={rows} showTimeZoneLabel={false} />);
    expect(without.queryByRole("button")).toBeNull();

    const withCfg = render(
      <TrendMonitor rows={rows} zoomConfig={{ baseUrl: "http://localhost" }} showTimeZoneLabel={false} />,
    );
    expect(withCfg.queryByRole("button")).not.toBeNull();
  });
});

describe("computeInterpolatedSeries", () => {
  it("passes observed values through unchanged (including zero)", () => {
    expect(computeInterpolatedSeries([10, 0, 20])).toEqual([10, 0, 20]);
  });

  it("linearly interpolates between two bracketing observations", () => {
    const out = computeInterpolatedSeries([100, null, null, 400]);
    expect(out[1]).toBeCloseTo(200);
    expect(out[2]).toBeCloseTo(300);
  });

  it("extrapolates trailing gaps with decay toward zero", () => {
    const out = computeInterpolatedSeries([100, 100, 100, null, null]);
    // Each successive future step shrinks by the per-step decay factor.
    expect(out[3]).toBeGreaterThan(0);
    expect(out[4]).toBeGreaterThan(0);
    expect(out[4]).toBeLessThan(out[3]);
    // Extrapolation never exceeds the observed base.
    expect(out[3]).toBeLessThan(100);
  });

  it("returns all zeros when no observations exist", () => {
    expect(computeInterpolatedSeries([null, null, null])).toEqual([0, 0, 0]);
  });
});
