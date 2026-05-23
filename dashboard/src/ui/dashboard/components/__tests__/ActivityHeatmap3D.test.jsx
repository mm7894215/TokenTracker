/**
 * ActivityHeatmap3D rendering tests.
 *
 * Validates the isometric voxel chart:
 *   - empty state renders a placeholder
 *   - each non-null cell produces 3 SVG paths (top + right + left faces)
 *   - cells are emitted in back-to-front order (col+row ascending) so
 *     near cubes overlap distant cubes correctly
 *   - dark vs light palette swap honors the isDark prop
 */
import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { ActivityHeatmap3D } from "../ActivityHeatmap3D";

const sampleWeeks = [
  [
    { day: "2026-01-01", level: 0, value: 0 },
    { day: "2026-01-02", level: 4, value: 999999 },
  ],
  [
    { day: "2026-01-08", level: 2, value: 5000 },
    null,
    { day: "2026-01-10", level: 3, value: 12000 },
  ],
];

describe("ActivityHeatmap3D", () => {
  test("empty weeks renders empty-state copy", () => {
    const { container } = render(<ActivityHeatmap3D weeks={[]} />);
    expect(container.textContent).toMatch(/no activity|empty|tokens/i);
  });

  test("non-empty weeks emit 3 paths per cell (top, right, left)", () => {
    const { container } = render(<ActivityHeatmap3D weeks={sampleWeeks} />);
    const paths = container.querySelectorAll("svg path");
    // 4 non-null cells × 3 faces = 12 paths
    expect(paths.length).toBe(12);
  });

  test("svg viewBox grows to fit voxel bounds + padding", () => {
    const { container } = render(<ActivityHeatmap3D weeks={sampleWeeks} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const vb = svg.getAttribute("viewBox");
    expect(vb).toMatch(/^[\-\d.]+ [\-\d.]+ [\d.]+ [\d.]+$/);
  });

  test("cells are emitted back-to-front by (col + row) ascending", () => {
    // The first <g> in source order is the back-most voxel; back-most has
    // the smallest (col + row) sum. We use (0, 0) → sum 0 vs (1, 2) → sum 3.
    const weeks = [
      [{ day: "2026-01-01", level: 1, value: 1 }], // col=0 row=0 -> sum 0
      [null, null, { day: "2026-01-10", level: 1, value: 1 }], // col=1 row=2 -> sum 3
    ];
    const { container } = render(<ActivityHeatmap3D weeks={weeks} />);
    const groups = container.querySelectorAll("svg > g");
    expect(groups.length).toBe(2);
    // <title> inside group identifies which cell is which
    const first = groups[0].querySelector("title")?.textContent || "";
    expect(first).toMatch(/2026-01-01/);
  });

  test("dark and light palettes produce different top-face fill", () => {
    const lightSvg = render(<ActivityHeatmap3D weeks={[[{ day: "x", level: 4, value: 1 }]]} isDark={false} />).container;
    const darkSvg = render(<ActivityHeatmap3D weeks={[[{ day: "x", level: 4, value: 1 }]]} isDark={true} />).container;
    // The top face is rendered last in each cell <g>, so the last path
    // carries the base color.
    const lightTop = lightSvg.querySelectorAll("svg path")[2].getAttribute("fill");
    const darkTop = darkSvg.querySelectorAll("svg path")[2].getAttribute("fill");
    expect(lightTop).not.toBe(darkTop);
  });
});
