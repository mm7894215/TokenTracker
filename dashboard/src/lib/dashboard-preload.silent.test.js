import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  preloadDashboardPageResource,
  preloadLeaderboardDefaultState,
  resetDashboardPreload,
} from "./dashboard-preload.js";
import { getLeaderboard } from "./api";
import { runCloudUsageSyncNow } from "./cloud-sync";
import { refreshLeaderboard } from "./api";

vi.mock("./api", () => ({
  getLeaderboard: vi.fn(),
  refreshLeaderboard: vi.fn(),
}));

vi.mock("./cloud-sync", () => ({
  runCloudUsageSyncNow: vi.fn(),
}));

describe("dashboard preload silent side effects", () => {
  beforeEach(() => {
    resetDashboardPreload();
    getLeaderboard.mockReset();
    refreshLeaderboard.mockReset();
    runCloudUsageSyncNow.mockReset();
  });

  it("preloads leaderboard data directly without mounting the page or triggering visible side effects", async () => {
    const pageLoader = vi.fn(() => Promise.resolve({ LeaderboardPage: () => null }));
    const openLoginModal = vi.fn();
    const navigate = vi.fn();
    const toast = vi.fn();
    getLeaderboard.mockResolvedValue({ entries: [], page: 1, total_entries: 0 });

    await preloadDashboardPageResource("leaderboard", { loader: pageLoader });
    await preloadLeaderboardDefaultState({
      baseUrl: "https://edge.example",
      mockEnabled: false,
      signedIn: true,
      authLoading: false,
      userId: "user-1",
      openLoginModal,
      navigate,
      toast,
    });

    expect(pageLoader).toHaveBeenCalledTimes(1);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
    expect(openLoginModal).not.toHaveBeenCalled();
    expect(runCloudUsageSyncNow).not.toHaveBeenCalled();
    expect(refreshLeaderboard).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
