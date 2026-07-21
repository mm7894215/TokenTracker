// Pure helpers for the Usage Trend zoom view. Kept dependency-free and in a
// standalone module so both TrendMonitor.jsx and TrendMonitorZoomModal.jsx can
// import them without creating a component<->modal import cycle.

// Map the dashboard `period` to the trend granularity (mirrors the `mode`
// derivation in use-trend-data.ts: day -> hourly, total -> monthly, else daily).
export function granularityFromPeriod(period) {
  if (period === "day") return "hourly";
  if (period === "total") return "monthly";
  return "daily";
}

// True only for observed buckets — missing/future rows are previews, not data.
function isObserved(row) {
  return !!row && !row.missing && !row.future;
}

// Numeric tokens for a row, preferring the billable figure used for cost.
function rowBillable(row) {
  const raw = row?.billable_total_tokens ?? row?.total_tokens ?? row?.value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function rowTotal(row) {
  const raw = row?.total_tokens ?? row?.billable_total_tokens ?? row?.value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Aggregate stats over the observed buckets of a trend series. Cost is null when
// no row carries cost data, so callers can hide the row instead of rendering a
// misleading $0.00.
export function computeZoomStats(rows) {
  const list = Array.isArray(rows) ? rows.filter(isObserved) : [];

  let totalTokens = 0;
  let billableTokens = 0;
  let conversationCount = 0;
  let costSum = 0;
  let anyCost = false;
  let activeBuckets = 0;
  let peakValue = -1;
  let peakRow = null;

  for (const row of list) {
    const total = rowTotal(row);
    const billable = rowBillable(row);
    totalTokens += total;
    billableTokens += billable;

    const conv = Number(row?.conversation_count);
    if (Number.isFinite(conv) && conv > 0) conversationCount += conv;

    const cost = Number(row?.total_cost_usd);
    if (Number.isFinite(cost)) {
      anyCost = true;
      costSum += cost;
    }

    if (billable > 0) activeBuckets += 1;
    if (billable > peakValue) {
      peakValue = billable;
      peakRow = row;
    }
  }

  return {
    totalTokens,
    billableTokens,
    conversationCount,
    totalCostUsd: anyCost ? costSum : null,
    bucketCount: list.length,
    activeBuckets,
    peak: peakRow && peakValue > 0
      ? { value: peakValue, label: peakRow.hour || peakRow.day || peakRow.month || "" }
      : null,
  };
}

// Pad "1" -> "01".
function pad2(n) {
  return String(n).padStart(2, "0");
}

function resolveDateLocale(locale) {
  return typeof locale === "string" && locale.trim() ? locale : "en-US";
}

function parseDayKey(value) {
  const raw = String(value || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

function formatDayKey(value, locale, includeYear = true) {
  const date = parseDayKey(value);
  if (!date || typeof Intl === "undefined" || !Intl.DateTimeFormat) return String(value || "");
  try {
    return new Intl.DateTimeFormat(resolveDateLocale(locale), {
      ...(includeYear ? { year: "numeric" } : {}),
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return String(value || "");
  }
}

function formatMonthKey(value, locale) {
  const raw = String(value || "");
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw);
  if (!match) return raw;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])) {
    return raw;
  }
  try {
    return new Intl.DateTimeFormat(resolveDateLocale(locale), {
      year: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return raw;
  }
}

function addUtcDays(dayKey, amount) {
  const date = parseDayKey(dayKey);
  if (!date) return dayKey;
  date.setUTCDate(date.getUTCDate() + amount);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// Precise time RANGE label for a hovered bucket, by granularity:
//   hourly  "YYYY-MM-DDTHH:MM:00" -> localized date + "HH:MM–HH:MM"
//   daily   "YYYY-MM-DD"          -> localized full date
//   monthly "YYYY-MM"             -> localized month + year
// Falls back to the raw label (or "") for anything unparseable.
export function formatBucketRange(row, granularity, locale) {
  if (!row) return "";

  if (granularity === "hourly") {
    const raw = String(row.hour || row.label || "");
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
    if (!m) return raw;
    const [, date, hh, mm] = m;
    const startMinutes = Number(hh) * 60 + Number(mm);
    const endMinutes = startMinutes + 30;
    const endH = Math.floor(endMinutes / 60) % 24;
    const endM = endMinutes % 60;
    const startDate = formatDayKey(date, locale);
    if (endMinutes >= 24 * 60) {
      const endDate = formatDayKey(addUtcDays(date, 1), locale);
      return `${startDate} ${hh}:${mm}–${endDate} ${pad2(endH)}:${pad2(endM)}`;
    }
    return `${startDate} ${hh}:${mm}–${pad2(endH)}:${pad2(endM)}`;
  }

  if (granularity === "monthly") {
    const raw = String(row.month || row.label || "");
    return formatMonthKey(raw, locale);
  }

  // daily
  const raw = String(row.day || row.label || "");
  return formatDayKey(raw, locale);
}

// Localized endpoint labels beneath the compact chart. Hourly ranges show the
// selected date only once so the two endpoints stay legible in narrow cards.
export function formatTrendRange(from, to, granularity, locale) {
  if (!from || !to) return null;
  const rawFrom = String(from);
  const rawTo = String(to);

  if (granularity === "hourly" && rawFrom === rawTo) {
    return {
      start: `${formatDayKey(rawFrom, locale)} · 00:00`,
      end: "24:00",
    };
  }

  if (granularity === "monthly") {
    return {
      start: formatMonthKey(rawFrom, locale),
      end: formatMonthKey(rawTo, locale),
    };
  }

  return {
    start: formatDayKey(rawFrom, locale),
    end: formatDayKey(rawTo, locale),
  };
}

// One-line insight copy key for the zoom stats panel, tiered by total volume so
// the line reads like a character note rather than a number it just restated.
// The caller passes formatted params to copy(): { active, peak }.
export function getTrendInsightKey(stats) {
  if (!stats || stats.activeBuckets === 0) return "trend.zoom.insight.empty";
  const total = stats.totalTokens || 0;
  if (total < 10_000_000) return "trend.zoom.insight.calm";
  if (total < 500_000_000) return "trend.zoom.insight.steady";
  if (total < 5_000_000_000) return "trend.zoom.insight.heavy";
  return "trend.zoom.insight.massive";
}

// Short localized axis-tick label for a bucket (no unnecessary date noise).
export function formatTickLabel(row, granularity, locale) {
  if (!row) return "";
  if (granularity === "hourly") {
    const m = /T(\d{2}:\d{2})/.exec(String(row.hour || row.label || ""));
    return m ? m[1] : "";
  }
  if (granularity === "monthly") {
    return formatMonthKey(String(row.month || row.label || ""), locale);
  }
  const day = String(row.day || row.label || "");
  return formatDayKey(day, locale, false);
}
