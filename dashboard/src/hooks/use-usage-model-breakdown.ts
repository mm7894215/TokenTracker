import { useCallback, useEffect, useMemo, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { isMockEnabled } from "../lib/mock-data";
import { getTimeZoneCacheKey } from "../lib/timezone";
import { getUsageModelBreakdown } from "../lib/api";

export function useUsageModelBreakdown({
  baseUrl,
  accessToken,
  guestAllowed = false,
  from,
  to,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
}: any = {}) {
  const [breakdown, setBreakdown] = useState<any | null>(null);
  const [source, setSource] = useState<string>("edge");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  const storageKey = useMemo(() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.modelBreakdown.${cacheKey}.${host}.${from}.${to}.${tzKey}`;
  }, [baseUrl, cacheKey, from, timeZone, to, tzOffsetMinutes]);

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.breakdown) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }, [storageKey]);

  const writeCache = useCallback(
    (payload: any) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (_e) {
        // ignore write errors
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors
    }
  }, [storageKey]);

  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const refresh = useCallback(async () => {
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    if (!resolvedToken && !mockEnabled && !isLocalMode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getUsageModelBreakdown({
        baseUrl,
        accessToken: resolvedToken,
        from,
        to,
        timeZone,
        tzOffsetMinutes,
      });
      setBreakdown(res || null);
      setSource("edge");
      if (res && cacheAllowed) {
        writeCache({ breakdown: res, fetchedAt: new Date().toISOString() });
      } else if (!cacheAllowed) {
        clearCache();
      }
    } catch (e) {
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.breakdown) {
          setBreakdown(cached.breakdown);
          setSource("cache");
          setError(null);
        } else {
          setBreakdown(null);
          setSource("edge");
          const err = e as any;
          setError(err?.message || String(err));
        }
      } else {
        setBreakdown(null);
        setSource("edge");
        const err = e as any;
        setError(err?.message || String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    from,
    mockEnabled,
    guestAllowed,
    cacheAllowed,
    readCache,
    timeZone,
    to,
    tokenReady,
    tzOffsetMinutes,
    clearCache,
    writeCache,
    isLocalMode,
  ]);

  useEffect(() => {
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode) {
      setBreakdown(null);
      setSource("edge");
      setError(null);
      setLoading(false);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setBreakdown(null);
      setSource("edge");
      setError(null);
    } else {
      const cached = readCache();
      if (cached?.breakdown) {
        setBreakdown(cached.breakdown);
        setSource("cache");
      }
    }
    refresh();
  }, [
    accessToken,
    mockEnabled,
    readCache,
    refresh,
    tokenReady,
    guestAllowed,
    cacheAllowed,
    clearCache,
    isLocalMode,
  ]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    breakdown,
    source: normalizedSource,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch (_e) {
    return null;
  }
}
