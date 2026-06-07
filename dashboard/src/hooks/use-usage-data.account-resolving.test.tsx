import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudUsageDaily,
  fetchCloudUsageSummary,
  getUsageDaily,
  getUsageSummary,
} from "../lib/api";
import { useUsageData } from "./use-usage-data";

vi.mock("../lib/api", () => ({
  getUsageDaily: vi.fn(),
  getUsageSummary: vi.fn(),
  fetchCloudUsageDaily: vi.fn(),
  fetchCloudUsageSummary: vi.fn(),
}));

vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: vi.fn(() => true),
  resolveAuthAccessToken: vi.fn(async (token) => token || "test-token"),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: vi.fn(() => false),
}));

const SUMMARY = { totals: { billable_total_tokens: 123, total_tokens: 123 }, rolling: {} };
const DAILY = { data: [{ day: "2026-06-05", total_tokens: 123 }] };

const baseProps = {
  baseUrl: "http://localhost:7680",
  from: "2026-06-05",
  to: "2026-06-05",
  includeDaily: true,
  cacheKey: "acct-resolving-test",
  accountView: false,
  accountAccessToken: null,
  accountRevision: 0,
};

describe("useUsageData — accountViewResolving gate (double-flash fix)", () => {
  beforeEach(() => {
    vi.mocked(getUsageSummary).mockReset().mockResolvedValue(SUMMARY as any);
    vi.mocked(getUsageDaily).mockReset().mockResolvedValue(DAILY as any);
    vi.mocked(fetchCloudUsageSummary).mockReset().mockResolvedValue(SUMMARY as any);
    vi.mocked(fetchCloudUsageDaily).mockReset().mockResolvedValue(DAILY as any);
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it("holds a loading state and fires NO local fetch while the scope is resolving", async () => {
    const { result } = renderHook(() =>
      useUsageData({ ...baseProps, accountViewResolving: true }),
    );

    // Give effects a chance to run.
    await new Promise((r) => setTimeout(r, 30));

    expect(result.current.loading).toBe(true);
    expect(result.current.summary).toBeNull();
    // The whole point: no local fetch fires that would paint soon-discarded data.
    expect(getUsageSummary).not.toHaveBeenCalled();
    expect(getUsageDaily).not.toHaveBeenCalled();
    expect(fetchCloudUsageSummary).not.toHaveBeenCalled();
  });

  it("does NOT paint a stale local cache while resolving (no local flash)", async () => {
    // Seed a local-scope cache the way the hook would have on a prior session.
    const cached = { summary: { billable_total_tokens: 999 }, rolling: {}, daily: [], from: "2026-06-05", to: "2026-06-05", includeDaily: true, fetchedAt: "x" };
    // The storageKey embeds scope/host/range/tz; rather than reconstruct it,
    // assert the behavioral guarantee: summary stays null while resolving even
    // if any cache exists, because the gate returns before readCache().
    for (let i = 0; i < window.localStorage.length; i++) { /* noop */ }
    window.localStorage.setItem("tokentracker.usage.acct-resolving-test.local.localhost:7680.2026-06-05.2026-06-05.daily.utc", JSON.stringify(cached));

    const { result } = renderHook(() =>
      useUsageData({ ...baseProps, accountViewResolving: true }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("releases the gate and fetches once the scope resolves (resolving -> false)", async () => {
    const { result, rerender } = renderHook(
      ({ resolving }) => useUsageData({ ...baseProps, accountViewResolving: resolving }),
      { initialProps: { resolving: true } },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(getUsageSummary).not.toHaveBeenCalled();

    rerender({ resolving: false });

    await waitFor(() => expect(getUsageSummary).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toEqual(SUMMARY.totals);
  });
});
