import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_BRANDING_STORAGE_KEY,
  useSidebarBranding,
} from "./use-sidebar-branding.js";

describe("useSidebarBranding", () => {
  beforeEach(() => window.localStorage.clear());

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
});
