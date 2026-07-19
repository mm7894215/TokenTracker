import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudUsageSummary,
  fetchAccountDevices,
  invalidateAccountResponseCache,
  renameAccountDevice,
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

  it("reuses a fresh account response and supports explicit invalidation", async () => {
    const args = { from: "2026-06-01", to: "2026-06-30", accessToken: JWT };
    await fetchCloudUsageSummary(args);
    await fetchCloudUsageSummary(args);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    invalidateAccountResponseCache();
    await fetchCloudUsageSummary(args);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached device data after a successful rename", async () => {
    let deviceName = "Old name";
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("tokentracker-device-rename")) {
        deviceName = "M4";
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        devices: [{ id: "dev-1", device_name: deviceName }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const args = { from: "2026-06-01", to: "2026-06-30", accessToken: JWT };
    const before = await fetchAccountDevices(args);
    expect(before.devices[0].device_name).toBe("Old name");

    await renameAccountDevice({ deviceId: "dev-1", name: "M4", accessToken: JWT });
    const after = await fetchAccountDevices(args);

    expect(after.devices[0].device_name).toBe("M4");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
