import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_USAGE_REFRESH_INTERVAL_MS,
  startLocalUsageAutoRefresh,
} from "./local-usage-auto-refresh";

function createEventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: vi.fn((name: string, fn: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(fn);
    }),
    removeEventListener: vi.fn((name: string, fn: () => void) => {
      listeners.get(name)?.delete(fn);
    }),
    dispatch(name: string) {
      for (const fn of listeners.get(name) || []) fn();
    },
  };
}

describe("startLocalUsageAutoRefresh", () => {
  it("refreshes on the interval and when a hidden dashboard becomes visible", async () => {
    let intervalCallback: () => void = () => {
      throw new Error("interval was not registered");
    };
    const windowEvents = createEventTarget();
    const documentEvents = createEventTarget();
    const documentRef = { ...documentEvents, visibilityState: "visible" as DocumentVisibilityState };
    const windowRef = {
      ...windowEvents,
      setInterval: vi.fn((callback: () => void, intervalMs: number) => {
        intervalCallback = callback;
        expect(intervalMs).toBe(LOCAL_USAGE_REFRESH_INTERVAL_MS);
        return 17 as unknown as number;
      }),
      clearInterval: vi.fn(),
    };
    const refresh = vi.fn(async () => {});

    const controller = startLocalUsageAutoRefresh({
      refresh,
      windowRef: windowRef as never,
      documentRef: documentRef as never,
    });

    intervalCallback();
    await controller.run();
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.visibilityState = "hidden";
    intervalCallback();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    documentRef.visibilityState = "visible";
    documentEvents.dispatch("visibilitychange");
    await controller.run();
    expect(refresh).toHaveBeenCalledTimes(2);

    controller.stop();
    expect(windowRef.clearInterval).toHaveBeenCalledWith(17);
    expect(windowEvents.removeEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(documentEvents.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("coalesces overlapping refresh attempts", async () => {
    let resolveRefresh: () => void = () => {
      throw new Error("refresh was not started");
    };
    const windowEvents = createEventTarget();
    const documentEvents = createEventTarget();
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const controller = startLocalUsageAutoRefresh({
      refresh,
      windowRef: {
        ...windowEvents,
        setInterval: vi.fn(() => 1),
        clearInterval: vi.fn(),
      } as never,
      documentRef: {
        ...documentEvents,
        visibilityState: "visible",
      } as never,
    });

    const first = controller.run();
    const second = controller.run();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh();
    await first;
    controller.stop();
  });
});
