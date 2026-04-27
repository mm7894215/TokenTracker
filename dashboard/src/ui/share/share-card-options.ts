export type ShareRankPeriod = "day" | "week" | "month" | "total";

export type ShareStatId =
  | "total_tokens"
  | "estimated_cost"
  | "active_days"
  | "longest_streak"
  | "top_model"
  | "top_model_share"
  | "avg_daily_tokens"
  | "avg_daily_cost"
  | "recorded_days"
  | "tracked_since"
  | "period"
  | "rank";

export const SHARE_CARD_MAX_VISIBLE_STATS = 8;

export const SHARE_RANK_PERIODS: readonly ShareRankPeriod[] = [
  "day",
  "week",
  "month",
  "total",
] as const;

export const SHARE_STAT_OPTIONS: readonly { id: ShareStatId }[] = [
  { id: "total_tokens" },
  { id: "estimated_cost" },
  { id: "active_days" },
  { id: "longest_streak" },
  { id: "top_model" },
  { id: "top_model_share" },
  { id: "avg_daily_tokens" },
  { id: "avg_daily_cost" },
  { id: "recorded_days" },
  { id: "tracked_since" },
  { id: "period" },
  { id: "rank" },
] as const;

export const DEFAULT_SHARE_VISIBLE_STATS: readonly ShareStatId[] = [
  "total_tokens",
  "estimated_cost",
  "active_days",
  "longest_streak",
  "top_model",
  "recorded_days",
  "avg_daily_tokens",
] as const;

export const GUEST_SHARE_VISIBLE_STATS: readonly ShareStatId[] = [
  "total_tokens",
  "estimated_cost",
  "active_days",
  "longest_streak",
  "top_model",
  "recorded_days",
  "avg_daily_tokens",
] as const;

const SHARE_STAT_IDS = new Set(SHARE_STAT_OPTIONS.map((option) => option.id));

type VisibleStatOptions = {
  rankEnabled?: boolean;
};

function isRankEnabled(options?: VisibleStatOptions): boolean {
  return options?.rankEnabled !== false;
}

function statAvailable(id: ShareStatId, options?: VisibleStatOptions): boolean {
  return id !== "rank" || isRankEnabled(options);
}

export function defaultShareVisibleStats(options?: VisibleStatOptions): ShareStatId[] {
  return normalizeVisibleStats(
    isRankEnabled(options) ? DEFAULT_SHARE_VISIBLE_STATS : GUEST_SHARE_VISIBLE_STATS,
    options,
  );
}

export function normalizeVisibleStats(
  value: readonly ShareStatId[] | null | undefined,
  options?: VisibleStatOptions,
): ShareStatId[] {
  const source = Array.isArray(value) && value.length ? value : defaultShareVisibleStats(options);
  const normalized: ShareStatId[] = [];
  for (const id of source) {
    if (!SHARE_STAT_IDS.has(id) || normalized.includes(id)) continue;
    if (!statAvailable(id, options)) continue;
    normalized.push(id);
    if (normalized.length >= SHARE_CARD_MAX_VISIBLE_STATS) break;
  }
  return normalized;
}

export function toggleVisibleStat(
  selected: readonly ShareStatId[],
  id: ShareStatId,
  options?: VisibleStatOptions,
): ShareStatId[] {
  if (!statAvailable(id, options)) return normalizeVisibleStats(selected, options);
  const normalized = normalizeVisibleStats(selected, options);
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  if (normalized.length >= SHARE_CARD_MAX_VISIBLE_STATS) return normalized;
  return [...normalized, id];
}
