import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeContext } from "../../../foundation/ThemeProvider.jsx";
import { ActivityHeatmap } from "../ActivityHeatmap.jsx";

const themeValue = {
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  toggleTheme: () => {},
};

function renderHeatmap() {
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
      <ActivityHeatmap heatmap={heatmap} timeZoneShortLabel="UTC" />
    </ThemeContext.Provider>,
  );
}

describe("ActivityHeatmap", () => {
  it("keeps the 2D day detail card transparent to pointer movement", () => {
    const { container } = renderHeatmap();
    const firstCell = container.querySelector(".heatmap-scroll-thin span[style*='background']");

    fireEvent.mouseEnter(firstCell);

    const tooltip = Array.from(document.body.querySelectorAll("div.fixed")).find((el) =>
      el.textContent.includes("Tokens"),
    );

    expect(tooltip).toBeTruthy();
    expect(tooltip.className).toContain("pointer-events-none");
    expect(tooltip.className).not.toContain("pointer-events-auto");
  });
});
