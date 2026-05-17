import { describe, expect, it } from "vitest";
import { getPaginationFlags, injectMeIntoFirstPage } from "../leaderboard-ui";

describe("getPaginationFlags", () => {
  it("keeps next enabled when totalPages is unknown", () => {
    const flags = getPaginationFlags({ page: 1, totalPages: null });
    expect(flags.canPrev).toBe(false);
    expect(flags.canNext).toBe(true);
  });

  it("disables next when totalPages is 0", () => {
    const flags = getPaginationFlags({ page: 1, totalPages: 0 });
    expect(flags.canPrev).toBe(false);
    expect(flags.canNext).toBe(false);
  });

  it("disables next when on last page", () => {
    const flags = getPaginationFlags({ page: 5, totalPages: 5 });
    expect(flags.canPrev).toBe(true);
    expect(flags.canNext).toBe(false);
  });
});

describe("injectMeIntoFirstPage", () => {
  it("pins me at the end with an ellipsis separator when rank is not contiguous", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      avatar_url: null,
      gpt_tokens: "1",
      claude_tokens: "2",
      total_tokens: "3",
    }));

    const me = { rank: 399, gpt_tokens: "10", claude_tokens: "20", total_tokens: "30" };
    const injected = injectMeIntoFirstPage({ entries, me, meLabel: "YOU", limit: 20 });

    // length stays at 20: trim last 2 natural rows, add ellipsis row + me row
    expect(injected).toHaveLength(20);
    // First 18 rows are untouched (ranks 1-18)
    expect(injected[0]?.rank).toBe(1);
    expect(injected[17]?.rank).toBe(18);
    // Ranks 19 and 20 are displaced to make room for separator + me
    expect(injected.some((entry) => entry.rank === 19)).toBe(false);
    expect(injected.some((entry) => entry.rank === 20)).toBe(false);
    // Penultimate row is the ellipsis separator
    expect(injected[18]?.is_ellipsis).toBe(true);
    // Last row is me
    expect(injected[19]?.is_me).toBe(true);
    expect(injected[19]?.rank).toBe(399);
    expect(injected[19]?.total_tokens).toBe("30");
  });

  it("appends me without separator when rank is contiguous with last row", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      avatar_url: null,
      gpt_tokens: "1",
      claude_tokens: "2",
      total_tokens: "3",
    }));

    const me = { rank: 21, gpt_tokens: "10", claude_tokens: "20", total_tokens: "30" };
    const injected = injectMeIntoFirstPage({ entries, me, meLabel: "YOU", limit: 20 });

    expect(injected).toHaveLength(20);
    // First 19 natural rows kept; rank 20 displaced by me at rank 21
    expect(injected[18]?.rank).toBe(19);
    expect(injected[19]?.is_me).toBe(true);
    expect(injected[19]?.rank).toBe(21);
    expect(injected.some((entry) => entry.is_ellipsis)).toBe(false);
  });

  it("does not inject when current page already includes me", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      avatar_url: null,
      gpt_tokens: "1",
      claude_tokens: "2",
      total_tokens: "3",
    }));
    entries[12].is_me = true;

    const me = { rank: 399, gpt_tokens: "10", claude_tokens: "20", total_tokens: "30" };
    const injected = injectMeIntoFirstPage({ entries, me, meLabel: "YOU", limit: 20 });

    expect(injected).toEqual(entries);
  });

  it("does not inject when me rank is missing", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      avatar_url: null,
      gpt_tokens: "1",
      claude_tokens: "2",
      total_tokens: "3",
    }));

    const me = { rank: null, gpt_tokens: "10", claude_tokens: "20", total_tokens: "30" };
    const injected = injectMeIntoFirstPage({ entries, me, meLabel: "YOU", limit: 20 });

    expect(injected).toEqual(entries);
  });
});
