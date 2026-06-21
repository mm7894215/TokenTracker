import { useCallback, useEffect, useState } from "react";
import { getUsageLimits } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";

type CodexLimitWindow = {
  readonly used_percent: number;
  readonly reset_at?: number;
  readonly limit_window_seconds?: number;
};

type CodexResetCredit = {
  readonly status: string;
  readonly reset_type?: string;
  readonly granted_at?: string;
  readonly expires_at: string;
};

type CodexResetCredits = {
  readonly available_count: number | null;
  readonly total_earned_count: number | null;
  readonly credits: readonly CodexResetCredit[];
};

type CodexUsageLimits = {
  readonly configured: boolean;
  readonly error?: string | null;
  readonly plan_label?: string | null;
  readonly primary_window?: CodexLimitWindow | null;
  readonly secondary_window?: CodexLimitWindow | null;
  readonly spark_primary_window?: CodexLimitWindow | null;
  readonly spark_secondary_window?: CodexLimitWindow | null;
  readonly reset_credits?: CodexResetCredits | null;
};

interface UsageLimitsData {
  fetched_at: string;
  claude: { configured: boolean; error?: string | null; plan_label?: string | null; five_hour?: { utilization: number; resets_at?: string }; seven_day?: { utilization: number; resets_at?: string }; seven_day_opus?: { utilization: number; resets_at?: string } | null; extra_usage?: { is_enabled: boolean; monthly_limit?: number | null; used_credits?: number | null; currency?: string | null } | null };
  codex: CodexUsageLimits;
  cursor: { configured: boolean; error?: string | null; plan_label?: string | null; membership_type?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  gemini: { configured: boolean; error?: string | null; plan_label?: string | null; account_email?: string | null; account_plan?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kimi: { configured: boolean; error?: string | null; plan_label?: string | null; membership_level?: string | null; subscription_type?: string | null; parallel_limit?: number | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kiro: { configured: boolean; error?: string | null; plan_label?: string | null; plan_name?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null };
  grok: { configured: boolean; error?: string | null; plan_label?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null };
  antigravity: { configured: boolean; error?: string | null; plan_label?: string | null; account_email?: string | null; account_plan?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
}

interface UsageLimitsInitialState {
  data?: UsageLimitsData | null;
  error?: string | null;
  status?: string;
}

interface UseUsageLimitsOptions {
  initialRefresh?: boolean;
  initialState?: UsageLimitsInitialState | null;
  publishToPreloadCache?: boolean;
}

export function useUsageLimits(options?: UseUsageLimitsOptions) {
  const hasInitialState = Boolean(options?.initialState);
  const [data, setData] = useState<UsageLimitsData | null>(() => (
    hasInitialState ? options?.initialState?.data ?? null : null
  ));
  const [error, setError] = useState<string | null>(() => (
    hasInitialState ? options?.initialState?.error ?? null : null
  ));
  const [isLoading, setIsLoading] = useState(!hasInitialState);
  const initialRefresh = Boolean(options?.initialRefresh);
  const publishToPreloadCache = Boolean(options?.publishToPreloadCache);

  const publishSuccessfulState = useCallback(
    (value: UsageLimitsData | null, source: "page-load" | "manual-refresh") => {
      if (!publishToPreloadCache || !value || typeof value !== "object") return;
      publishUsageLimitsPreloadState(value, { source });
    },
    [publishToPreloadCache],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await getUsageLimits({ refresh: true });
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      setData(nextData);
      setError(null);
      publishSuccessfulState(nextData, "manual-refresh");
    } catch (err) {
      setError((err as Error)?.message || String(err));
    }
  }, [publishSuccessfulState]);

  const refreshFromServerCache = useCallback(async () => {
    try {
      // Non-forcing read: serve from the server's cache rather than hitting
      // upstream providers, mirroring the mount fetch (forcing on every focus
      // is what tripped Claude's OAuth usage endpoint rate limit).
      const res = await getUsageLimits();
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      setData(nextData);
      setError(null);
      publishSuccessfulState(nextData, "page-load");
    } catch (err) {
      setError((err as Error)?.message || String(err));
    }
  }, [publishSuccessfulState]);

  // Auto-refresh when the dashboard regains focus / becomes visible again —
  // same throttled pattern as use-usage-data.ts, so a left-open Limits page
  // picks up new window utilization without a manual reload.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const MIN_GAP_MS = 15_000;
    let lastAt = Date.now(); // mount already fired the initial fetch below
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const nowMs = Date.now();
      if (nowMs - lastAt < MIN_GAP_MS) return;
      lastAt = nowMs;
      void refreshFromServerCache();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refreshFromServerCache]);

  useEffect(() => {
    if (hasInitialState && !initialRefresh) return;
    let cancelled = false;
    (async () => {
      try {
        // Mount fetch reads the server's cache (in-memory + disk-backed) rather than forcing
        // a live upstream call on every navigation — that repeated forcing is what tripped
        // Claude's OAuth usage endpoint rate limit. Only the manual refresh() forces upstream.
        const res = await getUsageLimits();
        if (cancelled) return;
        const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
        setData(nextData);
        setError(null);
        publishSuccessfulState(nextData, "page-load");
      } catch (err) {
        if (cancelled) return;
        setError((err as Error)?.message || String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasInitialState, initialRefresh, publishSuccessfulState]);

  return { data, error, isLoading, refresh };
}
