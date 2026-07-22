import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeContext } from "../../../foundation/ThemeProvider.jsx";
import { ActivityHeatmap } from "../ActivityHeatmap.jsx";

const themeValue = {
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  toggleTheme: () => {},
};

function renderHeatmap(props = {}) {
  const heatmap = {
    to: "2026-05-02",
    weeks: [
      [
        { day: "2026-04-26", value: 0, total_tokens: 0, level: 0 },
        { day: "2026-04-27", value: 120, total_tokens: 120, level: 1 },
        { day: "2026-04-28", value: 240, total_tokens: 240, level: 2 },
        { day: "2026-04-29", value: 480, total_tokens: 480, level: 3 },
        { day: "2026-04-30", value: 960, total_tokens: 960, level: 4 },
        { day: "2026-05-01", value: 180, total_tokens: 180, level: 1 },
        { day: "2026-05-02", value: 360, total_tokens: 360, level: 2 },
      ],
    ],
  };

  return render(
    <ThemeContext.Provider value={themeValue}>
      <ActivityHeatmap heatmap={heatmap} timeZoneShortLabel="UTC" {...props} />
    </ThemeContext.Provider>,
  );
}

describe("ActivityHeatmap", () => {
  afterEach(() => {
    window.localStorage.removeItem("tt:heatmap-view");
  });

  it("keeps the 2D day detail card transparent to pointer movement", async () => {
    const { container } = renderHeatmap();
    const firstCell = container.querySelector(".heatmap-scroll-thin span[style*='background']");

    fireEvent.mouseEnter(firstCell);

    const tooltip = await waitFor(() => {
      const match = document.body.querySelector("div.fixed");
      expect(match).toBeTruthy();
      return match;
    });

    expect(tooltip.className).toContain("pointer-events-none");
    expect(tooltip.className).not.toContain("pointer-events-auto");
  });

  it("reserves scrollbar clearance only for the standalone 2D view", () => {
    const standalone = renderHeatmap();
    expect(standalone.container.querySelector(".heatmap-scroll-thin").className).toContain("pb-1");
    standalone.unmount();

    const embedded = renderHeatmap({ embedded: true });
    expect(embedded.container.querySelector(".heatmap-scroll-thin").className).not.toContain("pb-1");
  });

  it("forces 2D when embedded, ignoring the persisted 3D dashboard preference", () => {
    // Reproduces the leaderboard-modal regression: picking 3D on the standalone
    // dashboard persists "3d" to localStorage, which the embedded modal instance
    // would otherwise read and render in 3D.
    window.localStorage.setItem("tt:heatmap-view", "3d");

    const { container } = renderHeatmap({ embedded: true });

    // The 2D scroll container only renders in 2D view, so its presence proves
    // the embedded instance stayed 2D despite the persisted 3D preference.
    expect(container.querySelector(".heatmap-scroll-thin")).toBeTruthy();
    // Embedded hosts expose no 2D/3D toggle.
    expect(container.querySelector("[role='tablist']")).toBeNull();
    // The embedded instance must not clobber the dashboard's persisted choice.
    expect(window.localStorage.getItem("tt:heatmap-view")).toBe("3d");
  });
});
