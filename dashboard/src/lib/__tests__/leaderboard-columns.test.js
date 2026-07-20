import { describe, expect, it } from "vitest";
import {
  LEADERBOARD_TOKEN_COLUMNS,
  lbStickyTdRank,
  lbStickyTdUser,
} from "../leaderboard-columns.js";

describe("LEADERBOARD_TOKEN_COLUMNS", () => {
  it("uses the bundled Hermes brand logo for the Hermes leaderboard column", () => {
    const hermesColumn = LEADERBOARD_TOKEN_COLUMNS.find((col) => col.key === "hermes_tokens");

    expect(hermesColumn?.icon).toBe("/brand-logos/hermes.svg");
  });
});

describe("leaderboard sticky row cells", () => {
  it("uses opaque dark hover backgrounds so scrolled values cannot bleed through", () => {
    for (const className of [lbStickyTdRank(false), lbStickyTdUser(false)]) {
      expect(className).toContain("dark:group-hover:bg-oai-gray-900");
      expect(className).not.toContain("dark:group-hover:bg-oai-gray-900/60");
    }
  });
});
