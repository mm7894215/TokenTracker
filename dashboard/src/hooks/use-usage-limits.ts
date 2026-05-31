import { useCallback, useEffect, useState } from "react";
import { getUsageLimits } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";

interface UsageLimitsData {
  fetched_at: string;
  claude: { configured: boolean; error?: string | null; five_hour?: { utilization: number; resets_at?: string }; seven_day?: { utilization: number; resets_at?: string }; seven_day_opus?: { utilization: number; resets_at?: string } | null; extra_usage?: { is_enabled: boolean; monthly_limit?: number | null; used_credits?: number | null; currency?: string | null } | null };
  codex: { configured: boolean; error?: string | null; primary_window?: { used_percent: number; reset_at?: number; limit_window_seconds?: number } | null; secondary_window?: { used_percent: number; reset_at?: number; limit_window_seconds?: number } | null };
  cursor: { configured: boolean; error?: string | null; membership_type?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  gemini: { configured: boolean; error?: string | null; account_email?: string | null; account_plan?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kimi: { configured: boolean; error?: string | null; membership_level?: string | null; subscription_type?: string | null; parallel_limit?: number | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kiro: { configured: boolean; error?: string | null; plan_name?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null };
  antigravity: { configured: boolean; error?: string | null; account_email?: string | null; account_plan?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
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

  useEffect(() => {
    if (hasInitialState && !initialRefresh) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getUsageLimits(initialRefresh ? { refresh: true } : {});
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
