import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageDaily, getUsageHourly, getUsageMonthly } from "../lib/api";
import { useTrendData } from "./use-trend-data";

vi.mock("../lib/api", () => ({
  getUsageDaily: vi.fn(),
  getUsageHourly: vi.fn(),
  getUsageMonthly: vi.fn(),
}));

vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: vi.fn(() => true),
  resolveAuthAccessToken: vi.fn(async (token) => token || "test-token"),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: vi.fn(() => false),
}));

describe("useTrendData", () => {
  beforeEach(() => {
    vi.mocked(getUsageDaily).mockReset();
    vi.mocked(getUsageHourly).mockReset();
    vi.mocked(getUsageMonthly).mockReset();
    window.localStorage.clear();
  });

  function findHour(rows: any[], hour: string) {
    return rows.find((row) => row.hour === hour);
  }

  function hourlyStorageKey({
    cacheKey = "test-cache",
    scopeKey = "local",
    day = "2026-05-29",
    timeZone = "UTC",
    deviceScope = "all",
  } = {}) {
    return `tokentracker.trend.${cacheKey}.${scopeKey}.localhost:7680.hourly.${day}.tz:${timeZone}.${deviceScope}`;
  }

  it("treats elapsed hourly slots with no usage rows as real zero observations", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-05-29",
      data: [
        {
          hour: "2026-05-29T09:00:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
        {
          hour: "2026-05-29T10:00:00",
          total_tokens: 200,
          billable_total_tokens: 200,
        },
      ],
    });
    const now = new Date("2026-05-29T12:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(24));

    const idlePastHour = findHour(result.current.rows, "2026-05-29T08:00:00");
    expect(idlePastHour).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });

    const futureHour = findHour(result.current.rows, "2026-05-29T13:00:00");
    expect(futureHour).toMatchObject({
      total_tokens: null,
      billable_total_tokens: null,
      input_tokens: null,
      cached_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      conversation_count: null,
      missing: false,
      future: true,
    });
  });

  it("fills elapsed half-hour slots with zero observations without touching future slots", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-05-29",
      data: [
        {
          hour: "2026-05-29T09:30:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
      ],
    });
    const now = new Date("2026-05-29T12:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(48));

    expect(findHour(result.current.rows, "2026-05-29T08:30:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      missing: false,
      future: false,
    });
    expect(findHour(result.current.rows, "2026-05-29T13:00:00")).toMatchObject({
      total_tokens: null,
      billable_total_tokens: null,
      missing: false,
      future: true,
    });
  });

  it("normalizes cached null gaps to zero once their hour has elapsed", async () => {
    const cacheKey = "cached-hourly";
    window.localStorage.setItem(
      hourlyStorageKey({ cacheKey }),
      JSON.stringify({
        mode: "hourly",
        from: "2026-05-29",
        to: "2026-05-29",
        fetchedAt: "2026-05-29T10:15:00.000Z",
        rows: [
          {
            hour: "2026-05-29T08:00:00",
            total_tokens: null,
            billable_total_tokens: null,
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            missing: true,
            future: false,
          },
          {
            hour: "2026-05-29T13:00:00",
            total_tokens: null,
            billable_total_tokens: null,
            input_tokens: null,
            cached_input_tokens: null,
            cache_creation_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            conversation_count: null,
            missing: false,
            future: true,
          },
        ],
      }),
    );
    vi.mocked(getUsageHourly).mockRejectedValue(new Error("offline"));
    const now = new Date("2026-05-29T14:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        cacheKey,
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.source).toBe("cache"));

    expect(findHour(result.current.rows, "2026-05-29T08:00:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });
    expect(findHour(result.current.rows, "2026-05-29T13:00:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });
  });

  it("does not synthesize a zero observation for nonexistent DST hours", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-03-08",
      data: [
        {
          hour: "2026-03-08T01:00:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
        {
          hour: "2026-03-08T03:00:00",
          total_tokens: 200,
          billable_total_tokens: 200,
        },
      ],
    });
    const now = new Date("2026-03-08T08:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-03-08",
        to: "2026-03-08",
        timeZone: "America/New_York",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    expect(findHour(result.current.rows, "2026-03-08T02:00:00")).toBeUndefined();
  });
});
