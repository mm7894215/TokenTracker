import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageLimits } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { useUsageLimits } from "./use-usage-limits";

vi.mock("../lib/api", () => ({
  getUsageLimits: vi.fn(),
}));

vi.mock("../lib/dashboard-preload.js", () => ({
  publishUsageLimitsPreloadState: vi.fn(),
}));

const existingLimits = {
  fetched_at: "2026-05-30T10:00:00.000Z",
  claude: { configured: false },
  codex: { configured: false },
  cursor: { configured: false },
  gemini: { configured: false },
  kimi: {
    configured: true,
    primary_window: { used_percent: 42, reset_at: "2026-05-30T12:00:00.000Z" },
  },
  kiro: { configured: false },
  antigravity: { configured: false },
};

const freshLimits = {
  ...existingLimits,
  fetched_at: "2026-05-30T10:05:00.000Z",
  kimi: {
    configured: true,
    primary_window: { used_percent: 18, reset_at: "2026-05-30T12:30:00.000Z" },
  },
};

describe("useUsageLimits", () => {
  beforeEach(() => {
    vi.mocked(getUsageLimits).mockReset();
    vi.mocked(publishUsageLimitsPreloadState).mockReset();
  });

  it("uses reusable initial data immediately and writes the background refresh back to cache", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: true,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    expect(result.current.data).toBe(existingLimits);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await waitFor(() => expect(result.current.data).toEqual(freshLimits));

    expect(getUsageLimits).toHaveBeenCalledWith({ refresh: true });
    expect(publishUsageLimitsPreloadState).toHaveBeenCalledWith(freshLimits, {
      source: "page-load",
    });
  });

  it("keeps the initialRefresh fallback when no reusable initial data exists", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));

    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getUsageLimits).toHaveBeenCalledWith({ refresh: true });
    expect(result.current.data).toEqual(freshLimits);
    expect(result.current.error).toBeNull();
  });

  it("keeps initial cached data visible when the background refresh fails", async () => {
    vi.mocked(getUsageLimits).mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: true,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    expect(result.current.data).toBe(existingLimits);
    expect(result.current.isLoading).toBe(false);

    await waitFor(() => expect(result.current.error).toBe("network down"));

    expect(result.current.data).toBe(existingLimits);
    expect(publishUsageLimitsPreloadState).not.toHaveBeenCalled();
  });

  it("forces refresh manually and writes cache with the manual-refresh source", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: false,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    await Promise.resolve();
    expect(getUsageLimits).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh();
    });

    expect(getUsageLimits).toHaveBeenCalledTimes(1);
    expect(getUsageLimits).toHaveBeenCalledWith({ refresh: true });
    expect(result.current.data).toEqual(freshLimits);
    expect(publishUsageLimitsPreloadState).toHaveBeenCalledWith(freshLimits, {
      source: "manual-refresh",
    });
  });
});
