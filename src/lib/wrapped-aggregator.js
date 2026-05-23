"use strict";

/**
 * Wrapped aggregator — turns a list of queue.jsonl rows into a year-end
 * summary suitable for the `tracker wrapped` CLI command and the
 * /wrapped dashboard page.
 *
 * Input rows: { source, model, hour_start, input_tokens, cached_input_tokens,
 *               cache_creation_input_tokens, output_tokens,
 *               reasoning_output_tokens, total_tokens, conversation_count, ... }
 *
 * Output is a plain object (JSON-serializable) — no UI or stringification
 * concerns leak in here so the same aggregator powers the CLI and the
 * React Wrapped page.
 */

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function rowTokens(row) {
  return isFiniteNumber(row.billable_total_tokens)
    ? row.billable_total_tokens
    : isFiniteNumber(row.total_tokens)
    ? row.total_tokens
    : 0;
}

function rowDay(row) {
  // hour_start is ISO 8601 UTC. Slice to YYYY-MM-DD.
  return typeof row.hour_start === "string" ? row.hour_start.slice(0, 10) : null;
}

function rowYear(row) {
  const d = rowDay(row);
  if (!d) return null;
  return Number(d.slice(0, 4));
}

function isoHour(row) {
  // "2026-04-05T14:30:00.000Z" → 14
  if (typeof row.hour_start !== "string") return null;
  const m = /T(\d{2}):/.exec(row.hour_start);
  return m ? Number(m[1]) : null;
}

function topByValue(map, n) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/**
 * Compute a year-end Wrapped summary from queue rows.
 *
 * @param {Array} rows — Array of queue.jsonl objects.
 * @param {Object} [opts]
 * @param {number} [opts.year] — Restrict to a single calendar year (UTC).
 *                                Defaults to the most-recent year present.
 * @returns {Object} Wrapped summary.
 */
function aggregateWrapped(rows, opts = {}) {
  // queue.jsonl is append-only: each sync re-emits the cumulative totals for
  // every touched (source, model, hour_start). Naively summing every row
  // double-counts every previously synced bucket. Keep only the latest entry
  // per tuple — same dedup rule that local-api.js readQueueData enforces for
  // the dashboard. This makes `tracker wrapped` totals match what the
  // /wrapped dashboard page shows.
  const dedup = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
    dedup.set(key, row);
  }
  const all = Array.from(dedup.values());

  // Decide year to summarize. Prefer caller's year; otherwise the most
  // recent year that has data — which during a sync rollover may be the
  // current year (even if it has only a week of data).
  let year = isFiniteNumber(opts.year) ? Math.floor(opts.year) : null;
  if (year == null) {
    let latest = null;
    for (const r of all) {
      const y = rowYear(r);
      if (y != null && (latest == null || y > latest)) latest = y;
    }
    year = latest ?? new Date().getUTCFullYear();
  }

  const filtered = all.filter((r) => rowYear(r) === year);

  if (filtered.length === 0) {
    return {
      year,
      range: { from: null, to: null },
      totals: { tokens: 0, conversations: 0, sources: 0, models: 0, active_days: 0 },
      top: { sources: [], models: [], days: [] },
      peak_hour: null,
      longest_streak: { days: 0, from: null, to: null },
      highlights: [],
    };
  }

  // Group: source, model, day, hour-of-day
  const tokensBySource = new Map();
  const tokensByModel = new Map();
  const tokensByDay = new Map();
  const tokensByHourOfDay = new Map();
  let totalTokens = 0;
  let totalConvs = 0;
  let earliest = null;
  let latest = null;

  for (const row of filtered) {
    const t = rowTokens(row);
    totalTokens += t;
    if (isFiniteNumber(row.conversation_count)) totalConvs += row.conversation_count;
    if (row.source) tokensBySource.set(row.source, (tokensBySource.get(row.source) || 0) + t);
    if (row.model) tokensByModel.set(row.model, (tokensByModel.get(row.model) || 0) + t);
    const day = rowDay(row);
    if (day) tokensByDay.set(day, (tokensByDay.get(day) || 0) + t);
    const h = isoHour(row);
    if (h != null) tokensByHourOfDay.set(h, (tokensByHourOfDay.get(h) || 0) + t);
    if (row.hour_start) {
      if (!earliest || row.hour_start < earliest) earliest = row.hour_start;
      if (!latest || row.hour_start > latest) latest = row.hour_start;
    }
  }

  // Longest consecutive day streak among days with non-zero tokens.
  const activeDays = Array.from(tokensByDay.keys()).sort();
  let longestStreak = { days: 0, from: null, to: null };
  if (activeDays.length > 0) {
    let runStart = activeDays[0];
    let runPrev = activeDays[0];
    let runLen = 1;
    const stepDay = (iso, delta) => {
      const dt = new Date(iso + "T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + delta);
      return dt.toISOString().slice(0, 10);
    };
    longestStreak = { days: 1, from: runStart, to: runStart };
    for (let i = 1; i < activeDays.length; i++) {
      const day = activeDays[i];
      if (day === stepDay(runPrev, 1)) {
        runLen++;
        runPrev = day;
      } else {
        runStart = day;
        runPrev = day;
        runLen = 1;
      }
      if (runLen > longestStreak.days) {
        longestStreak = { days: runLen, from: runStart, to: runPrev };
      }
    }
  }

  // Peak hour-of-day (UTC).
  let peakHour = null;
  if (tokensByHourOfDay.size > 0) {
    const top = topByValue(tokensByHourOfDay, 1)[0];
    peakHour = { hour: top[0], tokens: top[1] };
  }

  const topSources = topByValue(tokensBySource, 5).map(([source, tokens]) => ({
    source,
    tokens,
    share: totalTokens > 0 ? tokens / totalTokens : 0,
  }));
  const topModels = topByValue(tokensByModel, 5).map(([model, tokens]) => ({
    model,
    tokens,
    share: totalTokens > 0 ? tokens / totalTokens : 0,
  }));
  const topDays = topByValue(tokensByDay, 5).map(([day, tokens]) => ({ day, tokens }));

  // Highlights — short, share-friendly one-liners derived from the numbers.
  const highlights = [];
  if (topModels.length > 0) {
    const m = topModels[0];
    highlights.push(`${m.model} powered ${(m.share * 100).toFixed(0)}% of your year.`);
  }
  if (topDays.length > 0) {
    const d = topDays[0];
    highlights.push(`Your busiest day was ${d.day} (${formatCompact(d.tokens)} tokens).`);
  }
  if (peakHour) {
    highlights.push(`You hit peak flow around ${String(peakHour.hour).padStart(2, "0")}:00 UTC.`);
  }
  if (longestStreak.days >= 2) {
    highlights.push(`Longest streak: ${longestStreak.days} consecutive days of coding with AI.`);
  }
  if (tokensBySource.size >= 4) {
    highlights.push(`You touched ${tokensBySource.size} different AI tools — that's range.`);
  }

  return {
    year,
    range: { from: earliest, to: latest },
    totals: {
      tokens: totalTokens,
      conversations: totalConvs,
      sources: tokensBySource.size,
      models: tokensByModel.size,
      active_days: activeDays.length,
    },
    top: { sources: topSources, models: topModels, days: topDays },
    peak_hour: peakHour,
    longest_streak: longestStreak,
    highlights,
  };
}

function formatCompact(n) {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, "") + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K";
  return String(Math.round(n));
}

module.exports = { aggregateWrapped, formatCompact };
