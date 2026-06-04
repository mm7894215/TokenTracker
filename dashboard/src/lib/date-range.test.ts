import { describe, expect, it } from "vitest";
import { getRangeForPeriod } from "./date-range";

const now = new Date("2026-06-03T04:00:00Z");

describe("getRangeForPeriod", () => {
  it("uses the current local calendar day for day", () => {
    expect(getRangeForPeriod("day", { timeZone: "UTC", now })).toEqual({
      from: "2026-06-03",
      to: "2026-06-03",
    });
  });

  it("uses a two-day local date window for rolling 24h", () => {
    expect(getRangeForPeriod("24h", { timeZone: "UTC", now })).toEqual({
      from: "2026-06-02",
      to: "2026-06-03",
    });
  });

  it("uses a rolling 7-day range for week", () => {
    expect(getRangeForPeriod("week", { timeZone: "UTC", now })).toEqual({
      from: "2026-05-28",
      to: "2026-06-03",
    });
  });

  it("uses a rolling 30-day range for month", () => {
    expect(getRangeForPeriod("month", { timeZone: "UTC", now })).toEqual({
      from: "2026-05-05",
      to: "2026-06-03",
    });
  });
});
