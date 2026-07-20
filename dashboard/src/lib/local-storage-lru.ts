// Bounded LRU bookkeeping for the localStorage response caches used by the
// usage/trend hooks. Cache keys embed from/to/tz/device, so every period or
// device switch mints a new key; without an index they accumulate forever in
// long-lived installs (native WebViews). The index stores keys most-recent
// first; entries past the cap are evicted on each touch.
export function touchLocalStorageCacheKey(
  indexKey: string,
  storageKey: string,
  maxEntries: number,
): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(indexKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string" && k !== indexKey)
      : [];
    const next = [storageKey, ...list.filter((k) => k !== storageKey)];
    const evicted = next.splice(maxEntries);
    for (const key of evicted) window.localStorage.removeItem(key);
    window.localStorage.setItem(indexKey, JSON.stringify(next));
  } catch {
    // Bookkeeping must never break the cache path (quota/private mode).
  }
}
