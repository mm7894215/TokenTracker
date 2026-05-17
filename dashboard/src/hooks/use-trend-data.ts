import { useCallback, useEffect, useMemo, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { formatDateLocal, formatDateUTC } from "../lib/date-range";
import { isMockEnabled } from "../lib/mock-data";
import { getLocalDayKey, getTimeZoneCacheKey } from "../lib/timezone";
import { getUsageDaily, getUsageHourly, getUsageMonthly } from "../lib/api";

const DEFAULT_MONTHS = 24;
type AnyRecord = Record<string, any>;

export function useTrendData({
  baseUrl,
  accessToken,
  guestAllowed = false,
  period,
  from,
  to,
  months = DEFAULT_MONTHS,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
  sharedRows,
  sharedRange,
}: any = {}) {
  const [rows, setRows] = useState<any[]>([]);
  const [range, setRange] = useState<{ from?: any; to?: any }>(() => ({ from, to }));
  const [source, setSource] = useState<string>("edge");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;
  const sharedEnabled = Array.isArray(sharedRows);
  const sharedFrom = sharedRange?.from || from;
  const sharedTo = sharedRange?.to || to;

  const mode = useMemo(() => {
    if (period === "day") return "hourly";
    if (period === "total") return "monthly";
    return "daily";
  }, [period]);

  const storageKey = (() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    if (mode === "hourly") {
      const dayKey = to || from || "day";
      return `tokentracker.trend.${cacheKey}.${host}.hourly.${dayKey}.${tzKey}`;
    }
    if (mode === "monthly") {
      const toKey = to || "today";
      return `tokentracker.trend.${cacheKey}.${host}.monthly.${months}.${toKey}.${tzKey}`;
    }
    const rangeKey = `${from || ""}.${to || ""}`;
    return `tokentracker.trend.${cacheKey}.${host}.daily.${rangeKey}.${tzKey}`;
  })();

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.rows)) return null;
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
    if (sharedEnabled) {
      setRows(Array.isArray(sharedRows) ? sharedRows : []);
      setRange({ from: sharedFrom, to: sharedTo });
      setSource("shared");
      setFetchedAt(null);
      setLoading(false);
      setError(null);
      return;
    }
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    if (!resolvedToken && !mockEnabled && !isLocalMode) return;
    setLoading(true);
    setError(null);
    try {
      let response;
      if (mode === "hourly") {
        const day = to || from;
        response = await getUsageHourly({
          baseUrl,
          accessToken: resolvedToken,
          day,
          timeZone,
          tzOffsetMinutes,
        });
      } else if (mode === "monthly") {
        response = await getUsageMonthly({
          baseUrl,
          accessToken: resolvedToken,
          months,
          to,
          timeZone,
          tzOffsetMinutes,
        });
      } else {
        response = await getUsageDaily({
          baseUrl,
          accessToken: resolvedToken,
          from,
          to,
          timeZone,
          tzOffsetMinutes,
        });
      }

      const nextFrom = response?.from || from || response?.day || null;
      const nextTo = response?.to || to || response?.day || null;
      let nextRows = Array.isArray(response?.data) ? response.data : [];
      if (mode === "daily") {
        nextRows = fillDailyGaps(nextRows, nextFrom || from, nextTo || to, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      } else if (mode === "hourly") {
        nextRows = markHourlyFuture(nextRows, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      } else if (mode === "monthly") {
        nextRows = markMonthlyFuture(nextRows, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      }
      const nowIso = new Date().toISOString();

      setRows(nextRows);
      setRange({ from: nextFrom, to: nextTo });
      setSource("edge");
      setFetchedAt(nowIso);

      if (cacheAllowed) {
        writeCache({
          rows: nextRows,
          from: nextFrom,
          to: nextTo,
          mode,
          fetchedAt: nowIso,
        });
      } else {
        clearCache();
      }
    } catch (e) {
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.rows) {
          let filledRows =
            mode === "daily"
              ? fillDailyGaps(cached.rows || [], cached.from || from, cached.to || to, {
                  timeZone,
                  offsetMinutes: tzOffsetMinutes,
                  now,
                })
              : Array.isArray(cached.rows)
                ? cached.rows
                : [];
          if (mode === "hourly") {
            filledRows = markHourlyFuture(filledRows, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            });
          } else if (mode === "monthly") {
            filledRows = markMonthlyFuture(filledRows, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            });
          }
          setRows(filledRows);
          setRange({ from: cached.from || from, to: cached.to || to });
          setSource("cache");
          setFetchedAt(cached.fetchedAt || null);
          setError(null);
        } else {
          setRows([]);
          setRange({ from, to });
          setSource("edge");
          setFetchedAt(null);
          const err = e as any;
          setError(err?.message || String(err));
        }
      } else {
        setRows([]);
        setRange({ from, to });
        setSource("edge");
        setFetchedAt(null);
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
    mode,
    months,
    readCache,
    tokenReady,
    sharedEnabled,
    sharedFrom,
    sharedRows,
    sharedTo,
    timeZone,
    to,
    tzOffsetMinutes,
    now,
    clearCache,
    writeCache,
    isLocalMode,
  ]);

  useEffect(() => {
    if (sharedEnabled) {
      setRows(Array.isArray(sharedRows) ? sharedRows : []);
      setRange({ from: sharedFrom, to: sharedTo });
      setSource("shared");
      setFetchedAt(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode) {
      setRows([]);
      setRange({ from, to });
      setError(null);
      setLoading(false);
      setSource("edge");
      setFetchedAt(null);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setRows([]);
      setRange({ from, to });
      setError(null);
      setSource("edge");
      setFetchedAt(null);
    } else {
      const cached = readCache();
      if (cached?.rows) {
        let filledRows =
          mode === "daily"
            ? fillDailyGaps(cached.rows || [], cached.from || from, cached.to || to, {
                timeZone,
                offsetMinutes: tzOffsetMinutes,
                now,
              })
            : Array.isArray(cached.rows)
              ? cached.rows
              : [];
        if (mode === "hourly") {
          filledRows = markHourlyFuture(filledRows, {
            timeZone,
            offsetMinutes: tzOffsetMinutes,
            now,
          });
        } else if (mode === "monthly") {
          filledRows = markMonthlyFuture(filledRows, {
            timeZone,
            offsetMinutes: tzOffsetMinutes,
            now,
          });
        }
        setRows(filledRows);
        setRange({ from: cached.from || from, to: cached.to || to });
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
    sharedEnabled,
    sharedFrom,
    sharedRows,
    sharedTo,
    tokenReady,
    guestAllowed,
    cacheAllowed,
    clearCache,
    isLocalMode,
  ]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    rows,
    from: range.from || from,
    to: range.to || to,
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

function markHourlyFuture(rows: any[], { timeZone, offsetMinutes, now }: any = {}) {
  if (!Array.isArray(rows)) return [];
  const nowParts = getNowParts({ timeZone, offsetMinutes, now });
  if (!nowParts) return rows;

  return rows.map((row) => {
    const label = row?.hour || row?.label || "";
    const parsed = parseHourLabel(label);
    if (!parsed) {
      return { ...row, future: false };
    }
    const isFuture =
      parsed.dayNum > nowParts.dayNum ||
      (parsed.dayNum === nowParts.dayNum && parsed.slot > nowParts.slot);
    return { ...row, future: isFuture };
  });
}

function markMonthlyFuture(rows: any[], { timeZone, offsetMinutes, now }: any = {}) {
  if (!Array.isArray(rows)) return [];
  const nowParts = getNowParts({ timeZone, offsetMinutes, now });
  if (!nowParts) return rows;

  return rows.map((row) => {
    const label = row?.month || row?.label || "";
    const parsed = parseMonthLabel(label);
    if (!parsed) {
      return { ...row, future: false };
    }
    const isFuture =
      parsed.year > nowParts.year ||
      (parsed.year === nowParts.year && parsed.month > nowParts.month);
    return { ...row, future: isFuture };
  });
}

function getNowParts({ timeZone, offsetMinutes, now }: any = {}) {
  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(baseDate);
      const values = parts.reduce((acc: AnyRecord, part: any) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {} as AnyRecord);
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      if (
        Number.isFinite(year) &&
        Number.isFinite(month) &&
        Number.isFinite(day) &&
        Number.isFinite(hour) &&
        Number.isFinite(minute)
      ) {
        const slot = hour * 2 + (minute >= 30 ? 1 : 0);
        return {
          year,
          month,
          day,
          hour,
          minute,
          dayNum: year * 10000 + month * 100 + day,
          slot,
        };
      }
    } catch (_e) {
      // fallback below
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(baseDate.getTime() + offsetMinutes * 60 * 1000);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const hour = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();
    const slot = hour * 2 + (minute >= 30 ? 1 : 0);
    return {
      year,
      month,
      day,
      hour,
      minute,
      dayNum: year * 10000 + month * 100 + day,
      slot,
    };
  }

  const year = baseDate.getFullYear();
  const month = baseDate.getMonth() + 1;
  const day = baseDate.getDate();
  const hour = baseDate.getHours();
  const minute = baseDate.getMinutes();
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);
  return {
    year,
    month,
    day,
    hour,
    minute,
    dayNum: year * 10000 + month * 100 + day,
    slot,
  };
}

function parseHourLabel(label: any) {
  if (!label) return null;
  const raw = String(label).trim();
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) return null;
  const dateParts = datePart.split("-");
  if (dateParts.length !== 3) return null;
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const timeParts = timePart.split(":");
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);
  return {
    dayNum: year * 10000 + month * 100 + day,
    slot,
  };
}

function parseMonthLabel(label: any) {
  if (!label) return null;
  const raw = String(label).trim();
  const parts = raw.split("-");
  if (parts.length !== 2) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}
