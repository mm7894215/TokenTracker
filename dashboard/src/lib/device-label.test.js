import { describe, expect, it } from "vitest";
import { formatDeviceLabel } from "./device-label";

describe("formatDeviceLabel", () => {
  it("turns the auto name with a machine-id suffix into '<platform> · <shortid>'", () => {
    expect(
      formatDeviceLabel({ id: "uuid-1", device_name: "Token Tracker (dashboard) #32fda7ee", platform: "MacIntel" }),
    ).toBe("Mac · 32fda7ee");
    expect(
      formatDeviceLabel({ id: "uuid-2", device_name: "Token Tracker (dashboard) #E6DEDAC5", platform: "Win32" }),
    ).toBe("Windows · e6dedac5");
  });

  it("falls back to the device id prefix for the suffix-less canonical name", () => {
    expect(
      formatDeviceLabel({ id: "abcdef0123456789", device_name: "Token Tracker (dashboard)", platform: "Linux x86_64" }),
    ).toBe("Linux · abcdef01");
  });

  it("returns a user-chosen name verbatim", () => {
    expect(formatDeviceLabel({ id: "x", device_name: "My MacBook", platform: "MacIntel" })).toBe("My MacBook");
  });

  it("maps platform families and defaults to Web", () => {
    expect(formatDeviceLabel({ id: "x", device_name: "Token Tracker (dashboard) #aaaaaaaa", platform: "iPhone" })).toBe("iOS · aaaaaaaa");
    expect(formatDeviceLabel({ id: "x", device_name: "Token Tracker (dashboard) #bbbbbbbb", platform: "" })).toBe("Web · bbbbbbbb");
  });

  it("returns null when there is nothing to show", () => {
    expect(formatDeviceLabel({ id: "", device_name: "" })).toBeNull();
    expect(formatDeviceLabel(null)).toBeNull();
  });
});
