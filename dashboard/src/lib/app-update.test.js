import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./app-update";

describe("isNewerVersion", () => {
  it("compares dotted versions with optional v prefixes", () => {
    expect(isNewerVersion("0.83.5", "v0.84.0")).toBe(true);
    expect(isNewerVersion("0.83.5", "0.83.6")).toBe(true);
    expect(isNewerVersion("0.83.5", "0.83.5")).toBe(false);
    expect(isNewerVersion("0.83.5", "0.83.4")).toBe(false);
  });

  it("normalizes missing version parts and rejects invalid tags", () => {
    expect(isNewerVersion("1.2", "1.2.1")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.2")).toBe(false);
    expect(isNewerVersion("dev", "v1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "latest")).toBe(false);
  });
});
