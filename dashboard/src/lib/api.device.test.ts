import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudUsageSummary,
  fetchAccountDevices,
  getLeaderboard,
  invalidateAccountResponseCache,
} from "./api";

vi.mock("./insforge-config", () => ({
  getInsforgeRemoteUrl: () => "https://edge.example.test",
  getInsforgeAnonKey: () => "anon-key",
}));
vi.mock("./auth-token", () => ({
  isValidJwtShape: () => true,
}));
vi.mock("./mock-data", () => ({
  isMockEnabled: () => false,
}));

const JWT = "header.payload.sig";

function lastFetchUrl() {
  const calls = (globalThis.fetch as any).mock.calls;
  return new URL(calls[calls.length - 1][0]);
}

describe("api device filter", () => {
  beforeEach(() => {
    invalidateAccountResponseCache();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as any;
  });
  afterEach(() => vi.restoreAllMocks());

  it("encodes device_id on cloud usage requests when a device is given", async () => {
    await fetchCloudUsageSummary({ from: "2026-06-01", to: "2026-06-30", device: "dev-1", accessToken: JWT });
    expect(lastFetchUrl().searchParams.get("device_id")).toBe("dev-1");
  });

  it("omits device_id when no device is given", async () => {
    await fetchCloudUsageSummary({ from: "2026-06-01", to: "2026-06-30", accessToken: JWT });
    expect(lastFetchUrl().searchParams.get("device_id")).toBeNull();
  });

  it("fetchAccountDevices hits the account-devices slug", async () => {
    await fetchAccountDevices({ from: "2026-06-01", to: "2026-06-30", accessToken: JWT });
    expect(lastFetchUrl().pathname).toContain("tokentracker-account-devices");
  });

  it("forces leaderboard reads to bypass browser and CDN caches", async () => {
    await getLeaderboard({ period: "week", limit: 20, offset: 0, userId: "user-1" });
    const init = (globalThis.fetch as any).mock.calls.at(-1)?.[1];
    expect(init?.cache).toBe("no-store");
  });

  it("reuses a fresh account response and supports explicit invalidation", async () => {
    const args = { from: "2026-06-01", to: "2026-06-30", accessToken: JWT };
    await fetchCloudUsageSummary(args);
    await fetchCloudUsageSummary(args);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    invalidateAccountResponseCache();
    await fetchCloudUsageSummary(args);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
