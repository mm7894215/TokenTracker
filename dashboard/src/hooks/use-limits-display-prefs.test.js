import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMIT_PROVIDER_IDS } from "../lib/limits-providers.js";
import {
  LIMIT_DISPLAY_MODES,
  useLimitsDisplayPrefs,
} from "./use-limits-display-prefs.js";

const DISPLAY_MODE_KEY = "tt.limits.displayMode";
const ORDER_KEY = "tt.limits.providerOrder";
const VISIBILITY_KEY = "tt.limits.providerVisibility";

describe("useLimitsDisplayPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  function installNativeBridge() {
    const messages = [];
    window.webkit = {
      messageHandlers: {
        nativeBridge: {
          postMessage(message) {
            messages.push(message);
          },
        },
      },
    };
    return messages;
  }

  it("exports the two-mode constant used across panel and settings", () => {
    expect(LIMIT_DISPLAY_MODES.USED).toBe("used");
    expect(LIMIT_DISPLAY_MODES.REMAINING).toBe("remaining");
    expect(Object.values(LIMIT_DISPLAY_MODES)).toEqual(["used", "remaining"]);
  });

  it("matches the provider list used for visibility/order keys", () => {
    expect([...LIMIT_PROVIDER_IDS].sort()).toEqual(
      [
        "antigravity",
        "claude",
        "codex",
        "copilot",
        "cursor",
        "gemini",
        "grok",
        "kimi",
        "kiro",
      ].sort(),
    );
  });

  it("defaults to used mode when no preference is stored", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
  });

  it("reads a stored remaining preference on first render", () => {
    window.localStorage.setItem(DISPLAY_MODE_KEY, LIMIT_DISPLAY_MODES.REMAINING);
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
  });

  it("falls back to used mode when localStorage holds an unknown value", () => {
    window.localStorage.setItem(DISPLAY_MODE_KEY, "garbage");
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
  });

  it("persists displayMode to localStorage on change", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.REMAINING,
    );
    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.USED);
    });
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.USED,
    );
  });

  it("sends dashboard displayMode changes to the native bridge", () => {
    const messages = installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());

    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });

    expect(messages).toContainEqual({
      type: "setSetting",
      key: "limitsDisplayMode",
      value: LIMIT_DISPLAY_MODES.REMAINING,
    });
  });

  it("applies native limitsDisplayMode pushes from the host app", () => {
    installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: { limitsDisplayMode: LIMIT_DISPLAY_MODES.REMAINING },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.REMAINING,
    );
  });

  it("does not touch unrelated storage keys when toggling displayMode", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    const orderBefore = window.localStorage.getItem(ORDER_KEY);
    const visibilityBefore = window.localStorage.getItem(VISIBILITY_KEY);
    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });
    expect(window.localStorage.getItem(ORDER_KEY)).toBe(orderBefore);
    expect(window.localStorage.getItem(VISIBILITY_KEY)).toBe(visibilityBefore);
  });

  it("reacts to cross-tab storage events on the displayMode key", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);

    act(() => {
      window.localStorage.setItem(
        DISPLAY_MODE_KEY,
        LIMIT_DISPLAY_MODES.REMAINING,
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DISPLAY_MODE_KEY,
          newValue: LIMIT_DISPLAY_MODES.REMAINING,
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
  });

  it("ignores storage events on unrelated keys", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "some.other.key", newValue: "x" }),
      );
    });
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
  });

  it("reset() returns displayMode to used alongside order/visibility", () => {
    window.localStorage.setItem(DISPLAY_MODE_KEY, LIMIT_DISPLAY_MODES.REMAINING);
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);

    act(() => {
      result.current.reset();
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.USED,
    );
  });
});
