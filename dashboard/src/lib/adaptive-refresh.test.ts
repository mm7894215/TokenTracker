import { describe, expect, it } from "vitest";
import { ADAPTIVE_REFRESH_DELAYS_MS, adaptiveRefreshDelay } from "./adaptive-refresh";

describe("adaptiveRefreshDelay", () => {
  it("backs off as interaction becomes older", () => {
    const now = 10_000_000_000;
    expect(adaptiveRefreshDelay({ now, lastInteractionAt: now - 60_000 })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.active);
    expect(adaptiveRefreshDelay({ now, lastInteractionAt: now - 30 * 60_000 })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.warm);
    expect(adaptiveRefreshDelay({ now, lastInteractionAt: now - 2 * 60 * 60_000 })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.idle);
    expect(adaptiveRefreshDelay({ now, visible: false })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.longIdle);
  });

  it("never backs a visible dashboard off beyond idle (passive monitoring)", () => {
    const now = 10_000_000_000;
    expect(adaptiveRefreshDelay({ now, lastInteractionAt: now - 9 * 60_000 })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.active);
    expect(adaptiveRefreshDelay({ now, lastInteractionAt: 0 })).toBe(ADAPTIVE_REFRESH_DELAYS_MS.idle);
  });
});
