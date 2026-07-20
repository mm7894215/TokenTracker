import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./native-bridge.js", () => ({
  isNativeEmbed: vi.fn(() => false),
  postNativeMessage: vi.fn(() => true),
}));

import { isNativeEmbed, postNativeMessage } from "./native-bridge.js";
import {
  ensureNotificationPermission,
  getNotificationPermission,
  watchNotificationPermission,
} from "./notification-permission.js";

describe("notification permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.chrome;
  });

  it("queries the macOS host on watch and reflects pushed status", () => {
    isNativeEmbed.mockReturnValue(true);
    const seen = [];
    const stop = watchNotificationPermission((status) => seen.push(status));
    expect(postNativeMessage).toHaveBeenCalledWith({ type: "getNotificationStatus" });

    window.dispatchEvent(new CustomEvent("native:notificationPermission", { detail: { status: "denied" } }));
    expect(seen.at(-1)).toBe("denied");

    window.dispatchEvent(new CustomEvent("native:notificationPermission", { detail: { status: "granted" } }));
    expect(seen.at(-1)).toBe("granted");
    stop();
  });

  it("asks the macOS host for permission on the enabling gesture", async () => {
    isNativeEmbed.mockReturnValue(true);
    await ensureNotificationPermission();
    expect(postNativeMessage).toHaveBeenCalledWith({ type: "requestNotificationPermission" });
  });

  it("treats the Windows tray host as granted (balloons need no permission)", async () => {
    isNativeEmbed.mockReturnValue(false);
    window.chrome = { webview: {} };
    expect(getNotificationPermission()).toBe("granted");
    await ensureNotificationPermission();
    expect(postNativeMessage).not.toHaveBeenCalled();
  });
});
