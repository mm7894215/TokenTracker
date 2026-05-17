import { useCallback, useEffect, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { formatDateLocal, formatDateUTC } from "../lib/date-range";
import { isMockEnabled } from "../lib/mock-data";
import { getLocalDayKey, getTimeZoneCacheKey } from "../lib/timezone";
import { getUsageDaily, getUsageSummary } from "../lib/api";

export function useUsageData({
  baseUrl,
  accessToken,
  guestAllowed = false,
  from,
  to,
  includeDaily = true,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
}: any = {}) {
  const [daily, setDaily] = useState<any[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [rolling, setRolling] = useState<any | null>(null);
  const [source, setSource] = useState<string>("edge");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  const storageKey = (() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const dailyKey = includeDaily ? "daily" : "summary";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.usage.${cacheKey}.${host}.${from}.${to}.${dailyKey}.${tzKey}`;
  })();

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.summary) return null;
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
        // ignore write errors (quota/private mode)
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors (quota/private mode)
    }
  }, [storageKey]);

  const isLocalMode = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const refresh = useCallback(async () => {
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    // 本地模式允许空 token
    if (!resolvedToken && !mockEnabled && !isLocalMode) return;
    setLoading(true);
    setError(null);
    try {
      let dailyRes = null;
      let summaryRes = null;
      if (includeDaily) {
        const [dailyResult, summaryResult] = await Promise.allSettled([
          getUsageDaily({
            baseUrl,
            accessToken: resolvedToken,
            from,
            to,
            timeZone,
            tzOffsetMinutes,
          }),
          getUsageSummary({
            baseUrl,
            accessToken: resolvedToken,
            from,
            to,
            timeZone,
            tzOffsetMinutes,
            rolling: true,
          }),
        ]);
        if (dailyResult.status === "rejected") throw dailyResult.reason;
        dailyRes = dailyResult.value;
        summaryRes = summaryResult.status === "fulfilled" ? summaryResult.value : null;
      } else {
        summaryRes = await getUsageSummary({
          baseUrl,
          accessToken: resolvedToken,
          from,
          to,
          timeZone,
          tzOffsetMinutes,
          rolling: true,
        });
      }

      let nextDaily = includeDaily && Array.isArray(dailyRes?.data) ? dailyRes.data : [];
      if (includeDaily) {
        nextDaily = fillDailyGaps(nextDaily, from, to, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      }
      let nextSummary = summaryRes?.totals || dailyRes?.summary?.totals || null;
      let nextRolling = summaryRes?.rolling || dailyRes?.summary?.rolling || null;
      if (includeDaily && !nextSummary && !summaryRes) {
        try {
          const fallback = await getUsageSummary({
            baseUrl,
            accessToken: resolvedToken,
            from,
            to,
            timeZone,
            tzOffsetMinutes,
            rolling: true,
          });
          nextSummary = fallback?.totals || null;
          nextRolling = fallback?.rolling || nextRolling;
        } catch (_e) {
          // Ignore summary fallback errors when daily data is available.
        }
      }
      const nowIso = new Date().toISOString();

      setDaily(nextDaily);
      setSummary(nextSummary);
      setRolling(nextRolling);
      setSource("edge");
      setFetchedAt(nowIso);

      if (nextSummary && cacheAllowed) {
        writeCache({
          summary: nextSummary,
          rolling: nextRolling,
          daily: nextDaily,
          from,
          to,
          includeDaily,
          fetchedAt: nowIso,
        });
      } else if (!cacheAllowed) {
        clearCache();
      }
    } catch (e) {
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.summary) {
          setSummary(cached.summary);
          setRolling(cached.rolling || null);
          const cachedDaily = Array.isArray(cached.daily) ? cached.daily : [];
          const filledDaily = includeDaily
            ? fillDailyGaps(cachedDaily, cached.from || from, cached.to || to, {
                timeZone,
                offsetMinutes: tzOffsetMinutes,
                now,
              })
            : cachedDaily;
          setDaily(filledDaily);
          setSource("cache");
          setFetchedAt(cached.fetchedAt || null);
          setError(null);
        } else {
          const err = e as any;
          setError(err?.message || String(err));
          setDaily([]);
          setSummary(null);
          setRolling(null);
          setSource("edge");
          setFetchedAt(null);
        }
      } else {
        const err = e as any;
        setError(err?.message || String(err));
        setDaily([]);
        setSummary(null);
        setRolling(null);
        setSource("edge");
        setFetchedAt(null);
      }
    } finally {
      setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    from,
    includeDaily,
    mockEnabled,
    guestAllowed,
    cacheAllowed,
    now,
    readCache,
    tokenReady,
    timeZone,
    to,
    tzOffsetMinutes,
    clearCache,
    writeCache,
    isLocalMode,
  ]);

  useEffect(() => {
    const isLocalMode = typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    const isLocalModeCheck = typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalModeCheck) {
      setDaily([]);
      setSummary(null);
      setRolling(null);
      setError(null);
      setLoading(false);
      setSource("edge");
      setFetchedAt(null);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setDaily([]);
      setSummary(null);
      setRolling(null);
      setError(null);
      setSource("edge");
      setFetchedAt(null);
    } else {
      const cached = readCache();
      if (cached?.summary) {
        setSummary(cached.summary);
        setRolling(cached.rolling || null);
        const cachedDaily = Array.isArray(cached.daily) ? cached.daily : [];
        const filledDaily = includeDaily
          ? fillDailyGaps(cachedDaily, cached.from || from, cached.to || to, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            })
          : cachedDaily;
        setDaily(filledDaily);
        setSource("cache");
        setFetchedAt(cached.fetchedAt || null);
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
    daily,
    summary,
    rolling,
    source: normalizedSource,
    fetchedAt,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch (_e) {
    return null;
  }
}

function parseUtcDate(yyyyMmDd: any) {
  if (!yyyyMmDd) return null;
  const raw = String(yyyyMmDd).trim();
  const parts = raw.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m, d));
  if (!Number.isFinite(dt.getTime())) return null;
  return formatDateUTC(dt) === raw ? dt : null;
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function fillDailyGaps(
  rows: any[],
  from: any,
  to: any,
  { timeZone, offsetMinutes, now }: any = {},
) {
  const start = parseUtcDate(from);
  const end = parseUtcDate(to);
  if (!start || !end || end < start) return Array.isArray(rows) ? rows : [];

  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const todayKey = getLocalDayKey({ timeZone, offsetMinutes, date: baseDate });
  const today = parseUtcDate(todayKey);
  const todayTime = today ? today.getTime() : baseDate.getTime();

  const byDay = new Map();
  for (const row of rows || []) {
    if (row?.day) byDay.set(row.day, row);
  }

  const filled = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const day = formatDateUTC(cursor);
    const existing = byDay.get(day);
    const isFuture = cursor.getTime() > todayTime;
    if (existing) {
      filled.push({ ...existing, missing: false, future: isFuture });
      continue;
    }
    filled.push({
      day,
      total_tokens: null,
      billable_total_tokens: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      missing: !isFuture,
      future: isFuture,
    });
  }

  return filled;
}
