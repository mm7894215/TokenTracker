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
    void run();
  }, intervalMs);
  const handleVisible = () => {
    if (documentRef.visibilityState === "visible") void run();
  };
  windowRef.addEventListener("focus", handleVisible);
  documentRef.addEventListener("visibilitychange", handleVisible);

  return {
    run,
    stop() {
      stopped = true;
      windowRef.clearInterval(timer);
      windowRef.removeEventListener("focus", handleVisible);
      documentRef.removeEventListener("visibilitychange", handleVisible);
    },
  };
}
