import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isNativeEmbed,
  onNativeSettings,
  requestNativeSettings,
  setNativeSetting,
} from "../lib/native-bridge";

/**
 * Display preferences for the Usage Limits panel.
 *
 * Mirrors the native macOS app's LimitsSettingsStore (order + visibility per provider),
 * persisted in localStorage. The display mode additionally syncs through NativeBridge
 * inside the macOS app so the dashboard, menu bar, and popover render the same mode.
 */

import {
  LIMIT_PROVIDER_ICON_KEYS,
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../lib/limits-providers.js";

const ALL_LIMIT_PROVIDERS = LIMIT_PROVIDER_IDS;

export { LIMIT_PROVIDER_ICON_KEYS, limitProviderIconKey, limitProviderName };

const ORDER_KEY = "tt.limits.providerOrder";
const VISIBILITY_KEY = "tt.limits.providerVisibility";
const DISPLAY_MODE_KEY = "tt.limits.displayMode";
const NATIVE_DISPLAY_MODE_KEY = "limitsDisplayMode";

export const LIMIT_DISPLAY_MODES = Object.freeze({
  USED: "used",
  REMAINING: "remaining",
});

const VALID_DISPLAY_MODES = new Set(Object.values(LIMIT_DISPLAY_MODES));

function readOrder() {
  if (typeof window === "undefined") return [...ALL_LIMIT_PROVIDERS];
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    if (!raw) return [...ALL_LIMIT_PROVIDERS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_LIMIT_PROVIDERS];
    // Merge with any new providers + filter out unknowns
    const known = parsed.filter((id) => ALL_LIMIT_PROVIDERS.includes(id));
    for (const id of ALL_LIMIT_PROVIDERS) {
      if (!known.includes(id)) known.push(id);
    }
    return known;
  } catch {
    return [...ALL_LIMIT_PROVIDERS];
  }
}

function readVisibility() {
  const defaults = Object.fromEntries(ALL_LIMIT_PROVIDERS.map((id) => [id, true]));
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(VISIBILITY_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    const merged = { ...defaults };
    for (const id of ALL_LIMIT_PROVIDERS) {
      if (typeof parsed[id] === "boolean") merged[id] = parsed[id];
    }
    return merged;
  } catch {
    return defaults;
  }
}

function readDisplayMode() {
  if (typeof window === "undefined") return LIMIT_DISPLAY_MODES.USED;
  try {
    const raw = window.localStorage.getItem(DISPLAY_MODE_KEY);
    return VALID_DISPLAY_MODES.has(raw) ? raw : LIMIT_DISPLAY_MODES.USED;
  } catch {
    return LIMIT_DISPLAY_MODES.USED;
  }
}

export function useLimitsDisplayPrefs() {
  const [order, setOrder] = useState(readOrder);
  const [visibility, setVisibility] = useState(readVisibility);
  const [displayMode, setDisplayModeState] = useState(readDisplayMode);

  const setDisplayMode = useCallback((mode) => {
    if (!VALID_DISPLAY_MODES.has(mode)) return;
    setDisplayModeState(mode);
    if (isNativeEmbed()) {
      setNativeSetting(NATIVE_DISPLAY_MODE_KEY, mode);
    }
  }, []);

  // Persist on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch { /* ignore */ }
  }, [order]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VISIBILITY_KEY, JSON.stringify(visibility));
    } catch { /* ignore */ }
  }, [visibility]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
    } catch { /* ignore */ }
  }, [displayMode]);

  // Native app sync: native pushes the canonical UserDefaults-backed value,
  // while explicit dashboard changes are sent through setDisplayMode().
  useEffect(() => {
    if (!isNativeEmbed()) return undefined;
    const unsubscribe = onNativeSettings((detail) => {
      const next = detail?.[NATIVE_DISPLAY_MODE_KEY];
      if (VALID_DISPLAY_MODES.has(next)) {
        setDisplayModeState(next);
      }
    });
    requestNativeSettings();
    return unsubscribe;
  }, []);

  // Cross-tab sync
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      if (e.key === ORDER_KEY) setOrder(readOrder());
      if (e.key === VISIBILITY_KEY) setVisibility(readVisibility());
      if (e.key === DISPLAY_MODE_KEY) setDisplayModeState(readDisplayMode());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((id) => {
    setVisibility((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const moveUp = useCallback((id) => {
    setOrder((prev) => {
      const idx = prev.indexOf(id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((id) => {
    setOrder((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }, []);

  /**
   * Reorder by dragging `sourceId` to the position of `targetId`.
   * Matches the Swift ReorderDropDelegate behavior.
   */
  const moveToward = useCallback((sourceId, targetId) => {
    if (sourceId === targetId) return;
    setOrder((prev) => {
      const from = prev.indexOf(sourceId);
      const to = prev.indexOf(targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setOrder([...ALL_LIMIT_PROVIDERS]);
    setVisibility(Object.fromEntries(ALL_LIMIT_PROVIDERS.map((id) => [id, true])));
    setDisplayMode(LIMIT_DISPLAY_MODES.USED);
  }, [setDisplayMode]);

  // Derived: visible providers in user's order
  const visibleOrdered = useMemo(
    () => order.filter((id) => visibility[id] !== false),
    [order, visibility],
  );

  return {
    order,
    visibility,
    displayMode,
    setDisplayMode,
    visibleOrdered,
    toggle,
    moveUp,
    moveDown,
    moveToward,
    reset,
  };
}
