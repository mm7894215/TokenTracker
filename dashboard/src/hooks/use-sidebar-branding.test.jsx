import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_BRANDING_STORAGE_KEY,
  useSidebarBranding,
} from "./use-sidebar-branding.js";

describe("useSidebarBranding", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("shows the sidebar brand by default and persists an opt-out", () => {
    const { result } = renderHook(() => useSidebarBranding());
    expect(result.current.visible).toBe(true);

    act(() => result.current.setVisible(false));

    expect(result.current.visible).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_BRANDING_STORAGE_KEY)).toBe("0");
  });

  it("keeps hook consumers in the same window synchronized", () => {
    const { result } = renderHook(() => ({
      first: useSidebarBranding(),
      second: useSidebarBranding(),
    }));

    act(() => result.current.first.toggle());

    expect(result.current.first.visible).toBe(false);
    expect(result.current.second.visible).toBe(false);
  });

  it("can toggle back on when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const { result } = renderHook(() => useSidebarBranding());

    act(() => result.current.toggle());
    expect(result.current.visible).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.visible).toBe(true);
  });
});
