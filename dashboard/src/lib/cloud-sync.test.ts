import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCloudDeviceSession } from "./cloud-sync-prefs";
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

function installFetchMock() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/functions/tokentracker-machine-id") {
      return okJson({ machineId: "machine-abcdef12" });
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
      return okJson({ ok: true });
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

    await runCloudUsageSyncNow(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toMatchObject({
      deviceToken: "device-token",
      drain: true,
      insforgeBaseUrl: "https://cloud.example",
    });
  });

  it("does not send drain for scheduled sync", async () => {
    const fetchMock = installFetchMock();

    await runCloudUsageSyncIfDue(async () => "access-token");

    expect(getLocalSyncBody(fetchMock)).toEqual({
      deviceToken: "device-token",
      insforgeBaseUrl: "https://cloud.example",
    });
  });
});
