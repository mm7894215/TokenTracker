import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInsforgeAnonKeyMock, getInsforgeRemoteUrlMock } = vi.hoisted(() => ({
  getInsforgeAnonKeyMock: vi.fn(() => "anon-key"),
  getInsforgeRemoteUrlMock: vi.fn(() => "https://example.insforge.app"),
}));

vi.mock("../insforge-config", () => ({
  getInsforgeAnonKey: getInsforgeAnonKeyMock,
  getInsforgeRemoteUrl: getInsforgeRemoteUrlMock,
}));

import { getPublicVisibility, setPublicVisibility } from "../api";

function makeJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=/g, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

function mockJsonFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("public visibility API", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    getInsforgeAnonKeyMock.mockClear();
    getInsforgeRemoteUrlMock.mockReset();
    getInsforgeRemoteUrlMock.mockReturnValue("https://example.insforge.app");
  });

  it("reads visibility through the public visibility edge function", async () => {
    const payload = {
      enabled: true,
      updated_at: "2026-03-28T16:00:00.000Z",
      share_token: "pv1-token",
    };
    const fetchMock = mockJsonFetch(payload);
    const accessToken = makeJwt({ sub: "user-123" });

    await expect(getPublicVisibility({ accessToken })).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.insforge.app/functions/tokentracker-public-visibility",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          apikey: "anon-key",
          Authorization: `Bearer ${accessToken}`,
        }),
      }),
    );
  });

  it("does not send malformed opaque tokens to the InsForge gateway", async () => {
    const fetchMock = mockJsonFetch({
      enabled: false,
      updated_at: null,
      share_token: null,
    });

    await getPublicVisibility({ accessToken: "opaque-token" });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.apikey).toBe("anon-key");
  });

  it("posts visibility settings through the edge function", async () => {
    const payload = {
      enabled: true,
      updated_at: "2026-03-28T16:05:00.000Z",
      share_token: "existing-share-token",
    };
    const fetchMock = mockJsonFetch(payload);
    const accessToken = makeJwt({ sub: "writer-1" });

    await expect(
      setPublicVisibility({ accessToken, enabled: true, anonymous: false }),
    ).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.insforge.app/functions/tokentracker-public-visibility",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: true, anonymous: false }),
        headers: expect.objectContaining({
          Authorization: `Bearer ${accessToken}`,
          apikey: "anon-key",
        }),
      }),
    );
  });

  it("throws clearly when the InsForge backend URL is not configured", async () => {
    getInsforgeRemoteUrlMock.mockReturnValue("");

    await expect(getPublicVisibility({ accessToken: "token" })).rejects.toThrow(
      "InsForge base URL not configured",
    );
  });
});
