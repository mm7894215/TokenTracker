import { adaptiveRefreshDelay } from "./adaptive-refresh";

export const LOCAL_USAGE_REFRESH_INTERVAL_MS = 30_000;

type AutoRefreshOptions = {
  refresh: () => Promise<unknown> | unknown;
  intervalMs?: number;
  windowRef?: Pick<Window, "setInterval" | "clearInterval" | "addEventListener" | "removeEventListener">;
  documentRef?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  onError?: (error: unknown) => void;
};

/**
 * Keep a visible local dashboard current without allowing overlapping reads.
 * Provider parsing is handled by the native server's background sync; this
 * loop only re-reads the resulting local aggregates.
 */
export function startLocalUsageAutoRefresh({
  refresh,
  intervalMs = LOCAL_USAGE_REFRESH_INTERVAL_MS,
  windowRef = window,
  documentRef = document,
  onError = () => {},
}: AutoRefreshOptions) {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastInteractionAt = Date.now();
  let nextDueAt = 0;

  const run = () => {
    if (stopped || documentRef.visibilityState !== "visible") return inFlight;
    if (inFlight) return inFlight;
    const pending = Promise.resolve()
      .then(() => refresh())
      .catch((error) => onError(error))
      .then(() => undefined)
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  const timer = windowRef.setInterval(() => {
    const now = Date.now();
    if (now < nextDueAt) return;
    nextDueAt = now + adaptiveRefreshDelay({
      visible: documentRef.visibilityState === "visible",
      lastInteractionAt,
      now,
    });
    void run();
  }, intervalMs);
  const handleVisible = () => {
    if (documentRef.visibilityState === "visible") {
      lastInteractionAt = Date.now();
      nextDueAt = 0;
      void run();
    }
  };
  const handleInteraction = () => { lastInteractionAt = Date.now(); };
  windowRef.addEventListener("focus", handleVisible);
  windowRef.addEventListener("pointerdown", handleInteraction);
  windowRef.addEventListener("keydown", handleInteraction);
  documentRef.addEventListener("visibilitychange", handleVisible);

  return {
    run,
    stop() {
      stopped = true;
      windowRef.clearInterval(timer);
      windowRef.removeEventListener("focus", handleVisible);
      windowRef.removeEventListener("pointerdown", handleInteraction);
      windowRef.removeEventListener("keydown", handleInteraction);
      documentRef.removeEventListener("visibilitychange", handleVisible);
    },
  };
}
