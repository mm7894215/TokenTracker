import { describe, expect, it } from "vitest";
import { LEADERBOARD_TOKEN_COLUMNS } from "../leaderboard-columns.js";

describe("LEADERBOARD_TOKEN_COLUMNS", () => {
  it("uses the bundled Hermes brand logo for the Hermes leaderboard column", () => {
    const hermesColumn = LEADERBOARD_TOKEN_COLUMNS.find((col) => col.key === "hermes_tokens");

    expect(hermesColumn?.icon).toBe("/brand-logos/hermes.svg");
  });
});
