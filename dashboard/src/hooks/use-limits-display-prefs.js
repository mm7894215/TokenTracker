import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Display preferences for the Usage Limits panel.
 *
 * Mirrors the native macOS app's LimitsSettingsStore (order + visibility per provider),
 * persisted in localStorage. Dashboard and native storage are intentionally separate
 * since WKWebView's localStorage is isolated from UserDefaults.
 */

export const ALL_LIMIT_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "kiro",
  "antigravity",
];

export const LIMIT_PROVIDER_NAMES = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  kiro: "Kiro",
  antigravity: "Antigravity",
};

export const LIMIT_PROVIDER_ICONS = {
  claude: "/brand-logos/claude-code.svg",
  codex: "/brand-logos/codex.svg",
  cursor: "/brand-logos/cursor.svg",
  gemini: "/brand-logos/gemini.svg",
  kiro: "/brand-logos/kiro.svg",
  antigravity: "/brand-logos/antigravity.svg",
};

const ORDER_KEY = "tt.limits.providerOrder";
const VISIBILITY_KEY = "tt.limits.providerVisibility";

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

export function useLimitsDisplayPrefs() {
  const [order, setOrder] = useState(readOrder);
  const [visibility, setVisibility] = useState(readVisibility);

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

  // Cross-tab sync
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      if (e.key === ORDER_KEY) setOrder(readOrder());
      if (e.key === VISIBILITY_KEY) setVisibility(readVisibility());
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
  }, []);

  // Derived: visible providers in user's order
  const visibleOrdered = useMemo(
    () => order.filter((id) => visibility[id] !== false),
    [order, visibility],
  );

  return { order, visibility, visibleOrdered, toggle, moveUp, moveDown, moveToward, reset };
}
