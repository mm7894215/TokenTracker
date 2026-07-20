import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommunityModels, getLeaderboard } from "../lib/api";
import {
  COMMUNITY_STATS_STORAGE_KEY,
  resetCommunityStatsCacheForTests,
  useCommunityStats,
} from "./use-community-stats";

vi.mock("../lib/api", () => ({
  getLeaderboard: vi.fn(),
  getCommunityModels: vi.fn(),
}));

describe("useCommunityStats", () => {
  beforeEach(() => {
    resetCommunityStatsCacheForTests();
    window.localStorage.clear();
    vi.mocked(getLeaderboard).mockReset();
    vi.mocked(getCommunityModels).mockReset();
    window.requestIdleCallback = (callback) => {
      callback();
      return 1;
    };
    window.cancelIdleCallback = vi.fn();
  });

  it("hydrates a fresh persistent cache without refetching", async () => {
    window.localStorage.setItem(COMMUNITY_STATS_STORAGE_KEY, JSON.stringify({
      cachedAt: Date.now(),
      data: {
        tokenFloor: 5_000,
        totalEntries: 42,
        top: [{ total_tokens: 900 }],
        topModels: [{ name: "gpt-5.5", tokens: 4_000, share: 80 }],
        providers: [{ name: "codex", tokens: 3_000, developers: 30, share: 60 }],
        dailyGrowth: [{ day: "2026-07-18", tokens: 500, active_developers: 12 }],
        tokenMix: [{ key: "input", tokens: 3_500, share: 70 }],
        userDistribution: [{ key: "1b_plus", developers: 20, developer_share: 47.6 }],
        platforms: [{ name: "darwin", machines: 25, share: 59.5 }],
        activeDevelopersTotal: 42,
        activeDevelopers30d: 31,
        tokens30d: 2_000,
        tokenGrowthPct: null,
        developerGrowthPct: 12.5,
      },
    }));

    const { result } = renderHook(() => useCommunityStats());

    expect(result.current).toMatchObject({
      status: "ready",
      tokenFloor: 5_000,
      totalEntries: 42,
      activeDevelopers30d: 31,
      tokenGrowthPct: null,
      developerGrowthPct: 12.5,
    });
    await Promise.resolve();
    expect(getLeaderboard).not.toHaveBeenCalled();
    expect(getCommunityModels).not.toHaveBeenCalled();
  });

  it("keeps a stale persistent cache visible when revalidation fails", async () => {
    window.localStorage.setItem(COMMUNITY_STATS_STORAGE_KEY, JSON.stringify({
      cachedAt: Date.now() - 10 * 60_000,
      data: {
        tokenFloor: 7_000,
        totalEntries: 55,
        top: [{ total_tokens: 1_200 }],
        topModels: [{ name: "claude-opus-4-8", tokens: 5_000, share: 71.4 }],
      },
    }));
    vi.mocked(getLeaderboard).mockRejectedValue(new Error("temporary backend failure"));
    vi.mocked(getCommunityModels).mockRejectedValue(new Error("temporary backend failure"));

    const { result } = renderHook(() => useCommunityStats());

    expect(result.current.status).toBe("ready");
    await waitFor(() => expect(getLeaderboard).toHaveBeenCalledTimes(1));
    expect(result.current).toMatchObject({
      status: "ready",
      tokenFloor: 7_000,
      totalEntries: 55,
    });
  });

  it("keeps the cached authoritative total when only model revalidation fails", async () => {
    window.localStorage.setItem(COMMUNITY_STATS_STORAGE_KEY, JSON.stringify({
      cachedAt: Date.now() - 10 * 60_000,
      data: {
        tokenFloor: 9_000,
        totalEntries: 60,
        top: [{ total_tokens: 2_000 }],
        topModels: [{ name: "gpt-5.5", tokens: 7_000, share: 77.8 }],
      },
    }));
    vi.mocked(getLeaderboard).mockResolvedValue({
      total_entries: 61,
      entries: [{ total_tokens: 2_500 }],
    });
    vi.mocked(getCommunityModels).mockRejectedValue(new Error("temporary model failure"));

    const { result } = renderHook(() => useCommunityStats());

    await waitFor(() => expect(result.current.totalEntries).toBe(61));
    expect(result.current.tokenFloor).toBe(9_000);
    expect(result.current.topModels).toEqual([
      { name: "gpt-5.5", tokens: 7_000, share: 77.8 },
    ]);
    expect(JSON.parse(window.localStorage.getItem(COMMUNITY_STATS_STORAGE_KEY)).cachedAt)
      .toBeLessThan(Date.now() - 5 * 60_000);
  });

  it("uses the community model aggregate total instead of the leaderboard sample sum", async () => {
    vi.mocked(getLeaderboard).mockResolvedValue({
      total_entries: 600,
      entries: [
        { total_tokens: 100, claude_tokens: 60, gpt_tokens: 40 },
        { total_tokens: 50, claude_tokens: 10, gpt_tokens: 40 },
      ],
    });
    vi.mocked(getCommunityModels).mockResolvedValue({
      total_tokens: 1000,
      top_models: [{ name: "claude-sonnet-4-6", tokens: 700, share: 70 }],
      providers: [{ name: "claude", tokens: 700, developers: 8, share: 70 }],
      daily_growth: [{ day: "2026-07-18", tokens: 90, active_developers: 3 }],
      token_mix: [{ key: "input", tokens: 600, share: 60 }],
      user_distribution: [{ key: "10m_100m", developers: 4, developer_share: 50 }],
      platforms: [{ name: "darwin", machines: 6, share: 75 }],
      active_developers_total: 8,
      active_developers_30d: 5,
      tokens_30d: 450,
      token_growth_pct: 7.2,
      developer_growth_pct: -3.1,
      generated_at: "2026-07-18T08:00:00.000Z",
    });

    const { result } = renderHook(() => useCommunityStats());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.tokenFloor).toBe(1000);
    expect(result.current.totalEntries).toBe(600);
    expect(result.current).toMatchObject({
      providers: [{ name: "claude", tokens: 700, developers: 8, share: 70 }],
      activeDevelopersTotal: 8,
      activeDevelopers30d: 5,
      tokens30d: 450,
      tokenGrowthPct: 7.2,
      developerGrowthPct: -3.1,
      generatedAt: "2026-07-18T08:00:00.000Z",
    });
    expect(JSON.parse(window.localStorage.getItem(COMMUNITY_STATS_STORAGE_KEY)).data)
      .toMatchObject({ activeDevelopers30d: 5, tokens30d: 450 });
  });

  it("falls back to the leaderboard sample floor when the aggregate total is unavailable", async () => {
    vi.mocked(getLeaderboard).mockResolvedValue({
      total_entries: 2,
      entries: [
        { total_tokens: 100, claude_tokens: 60, gpt_tokens: 40 },
        { total_tokens: 50, claude_tokens: 10, gpt_tokens: 40 },
      ],
    });
    vi.mocked(getCommunityModels).mockResolvedValue({ top_models: [] });

    const { result } = renderHook(() => useCommunityStats());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.tokenFloor).toBe(150);
    expect(window.localStorage.getItem(COMMUNITY_STATS_STORAGE_KEY)).toBeNull();
  });
});
