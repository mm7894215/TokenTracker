import { describe, expect, it } from "vitest";
import {
  DEFAULT_MENU_BAR_ITEMS,
  FALLBACK_MENU_BAR_ITEMS,
  normalizeMenuBarItems,
} from "./menu-bar-display.js";

describe("normalizeMenuBarItems", () => {
  it("keeps the default Token + Cost display when no valid selection exists", () => {
    expect(normalizeMenuBarItems(null)).toEqual(DEFAULT_MENU_BAR_ITEMS);
    expect(normalizeMenuBarItems(["unknown"])).toEqual(DEFAULT_MENU_BAR_ITEMS);
  });

  it("deduplicates, filters unknown ids, and preserves order", () => {
    expect(normalizeMenuBarItems(["claude7d", "todayCost", "claude7d", "missing"])).toEqual([
      "claude7d",
      "todayCost",
    ]);
  });

  it("caps selections to the native menu bar width limit", () => {
    const ids = FALLBACK_MENU_BAR_ITEMS.map((item) => item.id);
    expect(normalizeMenuBarItems(ids, FALLBACK_MENU_BAR_ITEMS, 3)).toEqual(ids.slice(0, 3));
  });
});
