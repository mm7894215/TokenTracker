import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const nativeBridgeMock = vi.hoisted(() => ({
  nativeApp: false,
  nativeEmbed: false,
  postNativeMessage: vi.fn(() => true),
  requestNativeSettings: vi.fn(),
}));

vi.mock("../lib/native-bridge.js", () => ({
  isNativeApp: () => nativeBridgeMock.nativeApp,
  isNativeEmbed: () => nativeBridgeMock.nativeEmbed,
  onNativeSettings: () => vi.fn(),
  postNativeMessage: nativeBridgeMock.postNativeMessage,
  requestNativeSettings: nativeBridgeMock.requestNativeSettings,
}));

let useAppUpdate;

describe("useAppUpdate", () => {
  beforeAll(async () => {
    vi.stubEnv("VITE_APP_VERSION", "0.83.5");
    ({ useAppUpdate } = await import("./use-app-update.js"));
  });

  beforeEach(() => {
    nativeBridgeMock.nativeApp = false;
    nativeBridgeMock.nativeEmbed = false;
    nativeBridgeMock.postNativeMessage.mockClear();
    nativeBridgeMock.requestNativeSettings.mockClear();
    global.fetch = vi.fn();
  });

  it("does not check for desktop releases in the web dashboard", () => {
    const { result } = renderHook(() => useAppUpdate());
    expect(result.current.available).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("surfaces a newer native release and delegates installation to the host", async () => {
    nativeBridgeMock.nativeApp = true;
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v99.0.0",
        html_url: "https://github.com/mm7894215/TokenTracker/releases/tag/v99.0.0",
      }),
    });

    const { result } = renderHook(() => useAppUpdate());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.latestVersion).toBe("v99.0.0");

    act(() => result.current.requestUpdate());
    expect(nativeBridgeMock.postNativeMessage).toHaveBeenCalledWith({
      type: "action",
      name: "checkForUpdates",
    });
  });
});
