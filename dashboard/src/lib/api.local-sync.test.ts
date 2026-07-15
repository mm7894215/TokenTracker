import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerLocalSync } from "./api";

vi.mock("./local-api-auth", () => ({
  getLocalApiAuthHeaders: vi.fn(async () => ({ "x-tokentracker-local-auth": "local-token" })),
}));

describe("triggerLocalSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests an all-local background sync for local dashboard reloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      triggerLocalSync({ auto: true, background: true, allLocalSources: true }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/functions/tokentracker-local-sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-tokentracker-local-auth": "local-token",
        }),
        body: JSON.stringify({ auto: true, background: true, allLocalSources: true }),
      }),
    );
  });

  it("keeps manual refresh as a full local sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerLocalSync();
    expect(fetchMock.mock.calls[0][1]?.body).toBe("{}");
  });
});
