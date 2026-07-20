export const ADAPTIVE_REFRESH_DELAYS_MS = Object.freeze({
  active: 30_000,
  warm: 2 * 60_000,
  idle: 10 * 60_000,
  longIdle: 30 * 60_000,
});

/**
 * Pure policy: recently used dashboards get fresh reads; idle tabs back off.
 *
 * The primary use case is passive monitoring — the dashboard sits on a second
 * monitor while the user codes elsewhere and never touches it — so a visible
 * dashboard is never allowed to back off beyond `idle`, and reaches even that
 * only after an hour without interaction. `longIdle` is reserved for hidden
 * documents (where the caller skips refreshes anyway).
 */
export function adaptiveRefreshDelay({
  visible = true,
  lastInteractionAt = 0,
  now = Date.now(),
} = {}) {
  if (!visible) return ADAPTIVE_REFRESH_DELAYS_MS.longIdle;
  const age = Math.max(0, now - (Number(lastInteractionAt) || 0));
  if (age <= 10 * 60_000) return ADAPTIVE_REFRESH_DELAYS_MS.active;
  if (age <= 60 * 60_000) return ADAPTIVE_REFRESH_DELAYS_MS.warm;
  return ADAPTIVE_REFRESH_DELAYS_MS.idle;
}
