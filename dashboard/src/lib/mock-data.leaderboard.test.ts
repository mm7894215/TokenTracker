import { describe, expect, it } from "vitest";
import { getMockLeaderboard } from "./mock-data";

describe("mock model leaderboard", () => {
  it("returns privacy-safe, ranked model rows with server-style pagination", () => {
    const firstPage = getMockLeaderboard({
      seed: "model-ranking",
      dimension: "models",
      period: "month",
      limit: 7,
      offset: 0,
    });
    const secondPage = getMockLeaderboard({
      seed: "model-ranking",
      dimension: "models",
      period: "month",
      limit: 7,
      offset: 7,
    });

    expect(firstPage).toMatchObject({
      dimension: "models",
      period: "month",
      page: 1,
      limit: 7,
      offset: 0,
      total_entries: 30,
      total_pages: 5,
      me: null,
      privacy: { minimum_developers: 3 },
    });
    expect(firstPage.entries).toHaveLength(7);
    expect(secondPage).toMatchObject({ page: 2, offset: 7 });
    expect(secondPage.entries).toHaveLength(7);
    expect(secondPage.entries[0].rank).toBe(8);

    for (const entry of firstPage.entries) {
      expect("model" in entry).toBe(true);
      if (!("model" in entry)) continue;
      expect(entry.model).toBeTruthy();
      expect(entry.developer_count).toBeGreaterThanOrEqual(3);
      expect(Number(entry.total_tokens)).toBeGreaterThan(0);
    }
    expect(firstPage.entries.map((entry) => Number(entry.total_tokens))).toEqual(
      [...firstPage.entries]
        .map((entry) => Number(entry.total_tokens))
        .sort((a, b) => b - a),
    );
  });

  it("keeps the existing developer ranking as the default dimension", () => {
    const result = getMockLeaderboard({ seed: "developer-ranking", limit: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toHaveProperty("user_id");
    expect(result.entries[0]).not.toHaveProperty("model");
  });
});
