import { describe, expect, it } from "vitest";
import {
  buildPetLimitSummary,
  buildPetLimitSummaries,
  buildQuipPool,
  formatPetLimitSummary,
} from "./pet-quips.js";

describe("desktop pet limit dialogue", () => {
  it("lists every used provider window that is not full", () => {
    const limits = {
      claude: {
        configured: true,
        error: null,
        five_hour: { utilization: 61, resets_at: "2099-01-01T00:00:00Z" },
      },
      codex: {
        configured: true,
        error: null,
        primary_window: { used_percent: 87, reset_at: 4102444800 },
      },
      cursor: {
        configured: true,
        error: null,
        primary_window: { used_percent: 0, reset_at: 4102444800 },
        tertiary_window: { used_percent: 100, reset_at: 4102444800 },
      },
    };

    const readings = buildPetLimitSummaries(limits);
    expect(readings.map(({ provider, window }) => `${provider} ${window}`)).toEqual([
      "Codex 5h",
      "Claude 5h",
    ]);

    const reading = buildPetLimitSummary(limits);

    expect(reading).toMatchObject({ provider: "Codex", window: "5h", usedPercent: 87 });
    expect(formatPetLimitSummary("zh-CN", reading)).toContain("Codex 5h · 接近上限");
    expect(formatPetLimitSummary("en", reading)).toContain(" · in ");
    expect(formatPetLimitSummary("en", reading)).not.toContain("↻");
    const atLimit = formatPetLimitSummary("en", { ...reading, usedPercent: 100 });
    expect(atLimit).toContain("Codex 5h · at limit");
    expect(atLimit).not.toMatch(/\d+%/);
  });

  it("adds the limit line to the tap conversation without replacing token quips", () => {
    const pool = buildQuipPool("en", {
      tokens: 1200,
      tokensText: "1.2K",
      costText: "$0.12",
      costValue: 0.12,
      limitText: "Codex 5h · near limit · in 2h",
    });

    expect(pool).toContain("Codex 5h · near limit · in 2h");
    expect(pool.some((line) => line.includes("1.2K"))).toBe(true);
  });
});
