import { formatDateLocal, formatDateUTC } from "./date-range";
import { toFiniteNumber } from "./format";

type HeatmapRangeOptions = {
  weeks?: number;
  now?: Date;
  weekStartsOn?: string;
};

type BuildHeatmapOptions = {
  dailyRows?: any[];
  weeks?: number;
  to?: string;
  weekStartsOn?: string;
};

type ActiveStreakOptions = {
  dailyRows?: any[];
  to?: string;
};

function parseDateString(yyyyMmDd: any) {
  if (typeof yyyyMmDd !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  if (!Number.isFinite(dt.getTime())) return null;
  return formatDateUTC(dt) === yyyyMmDd.trim() ? dt : null;
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function diffUtcDays(a: Date, b: Date) {
  const ms =
    Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
    Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  return Math.floor(ms / 86400000);
}

function quantile(sorted: number[], q: number) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const n = sorted.length;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sorted[base] ?? sorted[n - 1];
  const right = sorted[Math.min(n - 1, base + 1)] ?? sorted[n - 1];
  return Math.round(left + (right - left) * rest);
}

function clampLevel(level: number) {
  if (level <= 0) return 0;
  if (level >= 4) return 4;
  return level;
}

export function getHeatmapRangeLocal({
  weeks = 52,
  now,
  weekStartsOn = "sun",
}: HeatmapRangeOptions = {}) {
  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const to = formatDateLocal(baseDate);
  const end =
    parseDateString(to) ||
    new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()));

  const desired = weekStartsOn === "mon" ? 1 : 0;
  const endDow = end.getUTCDay();
  const endWeekStart = addUtcDays(end, -((endDow - desired + 7) % 7));
  const start = addUtcDays(endWeekStart, -7 * (Math.max(1, weeks) - 1));
  return { from: formatDateUTC(start), to };
}

export function buildActivityHeatmap({
  dailyRows,
  weeks = 52,
  to,
  weekStartsOn = "sun",
}: BuildHeatmapOptions = {}) {
  const end =
    parseDateString(to) ||
    new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const { from } = getHeatmapRangeLocal({
    weeks,
    now: end,
    weekStartsOn,
  });
  const start = parseDateString(from) || addUtcDays(end, -(weeks * 7 - 1));

  const startAligned = (() => {
    const startDow = start.getUTCDay();
    const desired = weekStartsOn === "mon" ? 1 : 0;
    const delta = (startDow - desired + 7) % 7;
    return addUtcDays(start, -delta);
  })();

  const valuesByDay = new Map();
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const day = typeof row?.day === "string" ? row.day : null;
    if (!day) continue;
    const value = toFiniteNumber(row?.billable_total_tokens ?? row?.total_tokens) ?? 0;
    valuesByDay.set(day, {
      value: Math.max(0, value),
      models: row?.models || null,
    });
  }

  const totalDays = diffUtcDays(startAligned, end) + 1;
  const weekCount = Math.ceil(totalDays / 7);

  const allValues = [];
  for (let i = 0; i < totalDays; i++) {
    const dt = addUtcDays(startAligned, i);
    const key = formatDateUTC(dt);
    const dayData = valuesByDay.get(key);
    const value = dayData ? dayData.value : 0;
    if (value > 0) allValues.push(value);
  }
  allValues.sort((a, b) => a - b);

  const t1 = quantile(allValues, 0.5);
  const t2 = quantile(allValues, 0.75);
  const t3 = quantile(allValues, 0.9);

  function levelFor(value: number) {
    if (!value || value <= 0) return 0;
    if (value <= t1) return 1;
    if (value <= t2) return 2;
    if (value <= t3) return 3;
    return 4;
  }

  const weeksOut = [];
  for (let w = 0; w < weekCount; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d;
      const dt = addUtcDays(startAligned, idx);
      if (dt.getTime() > end.getTime()) {
        week.push(null);
        continue;
      }
      const day = formatDateUTC(dt);
      const dayData = valuesByDay.get(day);
      const value = dayData ? dayData.value : 0;
      const models = dayData ? dayData.models : null;
      week.push({
        day,
        value,
        level: clampLevel(levelFor(value)),
        models,
      });
    }
    weeksOut.push(week);
  }

  const trimmed = weeksOut.length > weeks ? weeksOut.slice(weeksOut.length - weeks) : weeksOut;

  return {
    from,
    to: formatDateUTC(end),
    weeks: trimmed,
    thresholds: { t1, t2, t3 },
  };
}

export function computeActiveStreakDays({ dailyRows, to }: ActiveStreakOptions = {}) {
  const end =
    parseDateString(to) ||
    new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const valuesByDay = new Map();
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const day = typeof row?.day === "string" ? row.day : null;
    if (!day) continue;
    const value = toFiniteNumber(row?.billable_total_tokens ?? row?.total_tokens) ?? 0;
    valuesByDay.set(day, Math.max(0, value));
  }

  let streak = 0;
  for (let i = 0; i < 370; i++) {
    const day = formatDateUTC(addUtcDays(end, -i));
    const value = valuesByDay.get(day) ?? 0;
    if (value > 0) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}
