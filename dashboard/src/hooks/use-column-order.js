import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "tokentracker.leaderboard.columnOrder.v1";

function readStored() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : null;
  } catch {
    return null;
  }
}

function writeStored(order) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

/**
 * Merge stored order with the current schema:
 *  - keep stored keys that still exist (preserves user intent)
 *  - append any newly-introduced keys at the end (so schema additions surface)
 *  - drop stored keys that have been removed from the schema
 */
function mergeOrder(stored, defaults) {
  if (!stored) return defaults;
  const defaultSet = new Set(defaults);
  const kept = stored.filter((k) => defaultSet.has(k));
  const missing = defaults.filter((k) => !kept.includes(k));
  return [...kept, ...missing];
}

/**
 * Manage an ordered list of column keys with localStorage persistence.
 * Returns stable callbacks and syncs automatically when `defaults` changes.
 */
export function useColumnOrder(defaults) {
  const defaultsKey = useMemo(() => defaults.join("|"), [defaults]);

  const [order, setOrder] = useState(() => mergeOrder(readStored(), defaults));

  // If schema changed (new/removed keys), re-merge and persist the new shape.
  useEffect(() => {
    setOrder((prev) => {
      const merged = mergeOrder(prev, defaults);
      const unchanged =
        merged.length === prev.length && merged.every((k, i) => k === prev[i]);
      if (unchanged) return prev;
      writeStored(merged);
      return merged;
    });
    // defaultsKey captures the shape change; defaults itself is a fresh array each render.
  }, [defaultsKey, defaults]);

  const reorder = useCallback((activeKey, overKey) => {
    if (!activeKey || !overKey || activeKey === overKey) return;
    setOrder((prev) => {
      const from = prev.indexOf(activeKey);
      const to = prev.indexOf(overKey);
      if (from === -1 || to === -1) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      writeStored(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    writeStored(defaults);
    setOrder(defaults);
  }, [defaults]);

  return { order, reorder, reset };
}
