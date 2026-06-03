import { describe, expect, it } from "vitest";
import { getNavGroups } from "./Sidebar.jsx";

function navIds(groups) {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}

describe("getNavGroups", () => {
  it("hides leaderboard by default on local dashboard hosts", () => {
    expect(window.location.hostname).toBe("localhost");
    expect(navIds(getNavGroups())).not.toContain("leaderboard");
  });

  it("keeps leaderboard available when explicitly enabled for hosted/cloud UI", () => {
    expect(navIds(getNavGroups({ includeLeaderboard: true }))).toContain("leaderboard");
  });
});
