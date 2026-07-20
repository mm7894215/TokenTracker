import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_LEADERBOARD_REFRESHED_EVENT,
  clearCloudDeviceSession,
  getCloudUsageReady,
  setCloudUsageReady,
} from "./cloud-sync-prefs";
import { runCloudUsageSyncIfDue, runCloudUsageSyncNow } from "./cloud-sync";

vi.mock("./insforge-config", () => ({
  getInsforgeAnonKey: () => "anon-key",
  getInsforgeRemoteUrl: () => "https://cloud.example",
}));

vi.mock("./local-api-auth", () => ({
  getLocalApiAuthHeaders: async () => ({ "x-tokentracker-local-auth": "local-token" }),
}));

function okJson(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response;
}

function installFetchMock(options: { leaderboardOk?: boolean } = {}) {
  const leaderboardOk = options.leaderboardOk ?? true;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/functions/tokentracker-machine-id") {
      return okJson({ machineId: "machine-abcdef12", deviceName: "office-win" });
    }
    if (url === "https://cloud.example/functions/tokentracker-device-token-issue") {
      return okJson({
        token: "device-token",
        device_id: "device-id",
        created_at: "2026-06-13T00:00:00.000Z",
      });
    }
    if (url === "/functions/tokentracker-local-sync") {
      return okJson({ ok: true });
    }
    if (url === "https://cloud.example/functions/tokentracker-leaderboard-refresh") {
      return {
        ok: leaderboardOk,
        status: leaderboardOk ? 200 : 403,
        json: async () => ({ ok: leaderboardOk }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function getLocalSyncBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => url === "/functions/tokentracker-local-sync");
  expect(call).toBeTruthy();
  const init = call?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  return JSON.parse(String(init?.body));
}

function installLocalStorageMock() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  });
}

describe("cloud usage sync", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installLocalStorageMock();
    clearCloudDeviceSession();
  });

  it("sends drain for manual sync", async () => {
    const fetchMock = installFetchMock();
    const onSynced = vi.fn();
    window.addEventListener("tt.cloudUsageSynced", onSynced);

    await runCloudUsageSyncNow(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toMatchObject({
      deviceToken: "device-token",
      drain: true,
      insforgeBaseUrl: "https://cloud.example",
    });
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.find(([url]) => url === "https://cloud.example/functions/tokentracker-leaderboard-refresh")?.[1])
      .toMatchObject({ cache: "no-store" });
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
  });

  it("sends the local system name separately from the stable machine id", async () => {
    const fetchMock = installFetchMock();

    await runCloudUsageSyncNow(async () => "access-token");

    const issueCall = fetchMock.mock.calls.find(([url]) => url === "https://cloud.example/functions/tokentracker-device-token-issue");
    expect(issueCall).toBeTruthy();
    const issueBody = JSON.parse(String((issueCall?.[1] as RequestInit | undefined)?.body));
    expect(issueBody).toMatchObject({
      device_name: "office-win",
      machine_id: "machine-abcdef12",
    });
  });

  it("drains the full queue before the first scheduled cloud view becomes ready", async () => {
    const fetchMock = installFetchMock();
    const onSynced = vi.fn();
    const onLeaderboardRefresh = vi.fn();
    window.addEventListener("tt.cloudUsageSynced", onSynced);
    window.addEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);

    await runCloudUsageSyncIfDue(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toEqual({
      deviceToken: "device-token",
      drain: true,
      insforgeBaseUrl: "https://cloud.example",
    });
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onLeaderboardRefresh).toHaveBeenCalledTimes(1);
    expect(getCloudUsageReady()).toBe(true);
    window.removeEventListener("tt.cloudUsageSynced", onSynced);
    window.removeEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);
  });

  it("does not announce a leaderboard refresh when the refresh endpoint fails", async () => {
    installFetchMock({ leaderboardOk: false });
    const onLeaderboardRefresh = vi.fn();
    window.addEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);

    await runCloudUsageSyncNow(async () => "access-token");

    expect(onLeaderboardRefresh).not.toHaveBeenCalled();
    window.removeEventListener(CLOUD_LEADERBOARD_REFRESHED_EVENT, onLeaderboardRefresh);
  });

  it("keeps scheduled sync lightweight after cloud usage is ready", async () => {
    setCloudUsageReady(true);
    const fetchMock = installFetchMock();

    await runCloudUsageSyncIfDue(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toEqual({
      deviceToken: "device-token",
      insforgeBaseUrl: "https://cloud.example",
    });
  });
});
