import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDashboardPreloadSnapshot,
  getLeaderboardPreloadContextKey,
  getLeaderboardPreloadPageSize,
  preloadLeaderboardDefaultState,
  publishLeaderboardPreloadState,
  readLeaderboardPreloadState,
  resetDashboardPreload,
} from "./dashboard-preload.js";
import { getLeaderboard } from "./api";

vi.mock("./api", () => ({
  getLeaderboard: vi.fn(),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("leaderboard default state preload", () => {
  beforeEach(() => {
    resetDashboardPreload();
    getLeaderboard.mockReset();
    window.localStorage.clear();
  });

  it("builds the default leaderboard context from period, page size, offset, user, mock, base URL and access mode", async () => {
    window.localStorage.setItem("tokentracker:leaderboard:pageSize", "50");
    const data = {
      entries: [{ rank: 1, display_name: "Ada", total_tokens: 1200 }],
      page: 1,
      total_pages: 1,
      total_entries: 1,
    };
    getLeaderboard.mockResolvedValue(data);

    const contextKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });

    expect(getLeaderboardPreloadPageSize()).toBe(50);
    expect(contextKey).toBe(
      "leaderboard:accessMode=cloud|baseUrl=https://edge.example|mockEnabled=false|offset=0|pageSize=50|period=total|userId=user-1",
    );

    await expect(
      preloadLeaderboardDefaultState({
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      status: "fulfilled",
      data,
      contextKey,
    });

    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "https://edge.example",
      userId: "user-1",
      period: "total",
      limit: 50,
      offset: 0,
    });
    expect(getLeaderboard.mock.calls[0][0]).not.toHaveProperty("accessToken");
    expect(getLeaderboard.mock.calls[0][0]).not.toHaveProperty("Authorization");
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data });
  });

  it("separates readable leaderboard cache by every data access context dimension", () => {
    const baseOptions = {
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      offset: 0,
      pageSize: 20,
      period: "total",
      userId: "user-1",
    };
    const contextKey = getLeaderboardPreloadContextKey(baseOptions);
    const data = { entries: [{ rank: 1, display_name: "Ada" }], page: 1 };

    publishLeaderboardPreloadState(data, { contextKey });

    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data,
    });

    for (const variant of [
      { period: "week" },
      { pageSize: 50 },
      { offset: 20 },
      { userId: "user-2" },
      { baseUrl: "https://other.example" },
      { mockEnabled: true, accessMode: "mock" },
      { accessMode: "public" },
    ]) {
      const variantKey = getLeaderboardPreloadContextKey({
        ...baseOptions,
        ...variant,
      });

      expect(variantKey).not.toBe(contextKey);
      expect(readLeaderboardPreloadState(variantKey)).toBeNull();
    }
  });

  it("skips silently when no leaderboard base URL is configured outside mock mode", async () => {
    await expect(
      preloadLeaderboardDefaultState({
        baseUrl: "",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ status: "skipped" });

    expect(getLeaderboard).not.toHaveBeenCalled();
    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "skipped",
      error: "missing-base-url",
    });
    expect(readLeaderboardPreloadState(getLeaderboardPreloadContextKey({ baseUrl: "", mockEnabled: false }))).toBeNull();
  });

  it("allows mock leaderboard preload while cloud auth is still loading", async () => {
    getLeaderboard.mockResolvedValue({ entries: [], page: 1, total_entries: 0 });

    await expect(
      preloadLeaderboardDefaultState({
        baseUrl: "",
        mockEnabled: true,
        signedIn: false,
        authLoading: true,
        userId: null,
      }),
    ).resolves.toMatchObject({ status: "fulfilled" });

    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "",
      userId: null,
      period: "total",
      limit: 20,
      offset: 0,
    });
  });

  it("allows signed-out public leaderboard preload when a base URL is configured", async () => {
    const data = { entries: [{ rank: 1, display_name: "Public User" }], page: 1, total_entries: 1 };
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "public",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: null,
    });
    getLeaderboard.mockResolvedValue(data);

    await expect(
      preloadLeaderboardDefaultState({
        accessMode: "public",
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: false,
        authLoading: false,
        userId: null,
      }),
    ).resolves.toMatchObject({
      status: "fulfilled",
      data,
      contextKey,
    });

    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "https://edge.example",
      userId: null,
      period: "total",
      limit: 20,
      offset: 0,
    });
  });

  it("records fetch failures without throwing to callers or readable page state", async () => {
    getLeaderboard.mockRejectedValue(new Error("network down"));

    await expect(
      preloadLeaderboardDefaultState({
        baseUrl: "https://edge.example",
        mockEnabled: false,
        signedIn: true,
        authLoading: false,
        userId: "user-1",
      }),
    ).resolves.toBeNull();

    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "rejected",
      error: "network down",
    });
    expect(
      readLeaderboardPreloadState(
        getLeaderboardPreloadContextKey({
          baseUrl: "https://edge.example",
          mockEnabled: false,
          userId: "user-1",
        }),
      ),
    ).toBeNull();
  });

  it("does not let an in-flight preload repopulate cache after reset", async () => {
    const pending = deferred();
    const data = { entries: [{ rank: 1, display_name: "Ada" }], page: 1 };
    const contextKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    getLeaderboard.mockReturnValue(pending.promise);

    const preload = preloadLeaderboardDefaultState({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      signedIn: true,
      authLoading: false,
      userId: "user-1",
    });
    await Promise.resolve();
    expect(getDashboardPreloadSnapshot().targets.leaderboard.stateStatus).toBe("pending");

    resetDashboardPreload();
    pending.resolve(data);

    await expect(preload).resolves.toBeNull();
    expect(readLeaderboardPreloadState(contextKey)).toBeNull();
    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "idle",
      error: null,
    });
  });

  it("does not let rejected leaderboard state overwrite an existing fulfilled cache entry", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    const data = { entries: [{ rank: 1, display_name: "Ada" }], page: 1 };

    publishLeaderboardPreloadState(data, { contextKey });
    publishLeaderboardPreloadState(null, {
      contextKey,
      status: "rejected",
      error: "network down",
    });

    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "rejected",
      error: "network down",
    });
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data,
      contextKey,
    });
  });

  it("reads fulfilled leaderboard state repeatedly without consuming it", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    const data = { entries: [{ rank: 1, display_name: "Ada" }], page: 1 };

    publishLeaderboardPreloadState(data, { contextKey });

    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data });
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data });
  });

  it("evicts older leaderboard contexts when the window-session cache reaches its configured max", () => {
    resetDashboardPreload({ leaderboardMaxEntries: 2 });
    const firstKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "total",
      userId: "user-1",
    });
    const secondKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "week",
      userId: "user-1",
    });
    const thirdKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "month",
      userId: "user-1",
    });

    publishLeaderboardPreloadState({ entries: [{ display_name: "First" }] }, { contextKey: firstKey });
    publishLeaderboardPreloadState({ entries: [{ display_name: "Second" }] }, { contextKey: secondKey });
    publishLeaderboardPreloadState({ entries: [{ display_name: "Third" }] }, { contextKey: thirdKey });

    expect(getDashboardPreloadSnapshot().cache.leaderboard).toMatchObject({
      maxEntries: 2,
      size: 2,
      keys: [secondKey, thirdKey],
    });
    expect(readLeaderboardPreloadState(firstKey)).toBeNull();
    expect(readLeaderboardPreloadState(secondKey)).toMatchObject({
      data: { entries: [{ display_name: "Second" }] },
    });
    expect(readLeaderboardPreloadState(thirdKey)).toMatchObject({
      data: { entries: [{ display_name: "Third" }] },
    });
  });

  it("does not evict the active leaderboard context when trimming old entries", () => {
    resetDashboardPreload({ leaderboardMaxEntries: 2 });
    const activeKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "total",
      userId: "user-1",
    });
    const oldKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "week",
      userId: "user-1",
    });
    const newKey = getLeaderboardPreloadContextKey({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "month",
      userId: "user-1",
    });

    publishLeaderboardPreloadState({ entries: [{ display_name: "Active" }] }, { contextKey: activeKey });
    publishLeaderboardPreloadState({ entries: [{ display_name: "Old" }] }, { contextKey: oldKey });
    publishLeaderboardPreloadState(
      { entries: [{ display_name: "New" }] },
      {
        activeContextKey: activeKey,
        contextKey: newKey,
      },
    );

    expect(getDashboardPreloadSnapshot().cache.leaderboard.keys).toEqual([activeKey, newKey]);
    expect(readLeaderboardPreloadState(activeKey)).toMatchObject({
      data: { entries: [{ display_name: "Active" }] },
    });
    expect(readLeaderboardPreloadState(oldKey)).toBeNull();
    expect(readLeaderboardPreloadState(newKey)).toMatchObject({
      data: { entries: [{ display_name: "New" }] },
    });
  });
});
