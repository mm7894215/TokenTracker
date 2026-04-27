import React from "react";
import { copy } from "../../lib/copy";
import {
  SHARE_CARD_MAX_VISIBLE_STATS,
  SHARE_RANK_PERIODS,
  SHARE_STAT_OPTIONS,
  type ShareRankPeriod,
  type ShareStatId,
} from "./share-card-options";

type ShareDisplayOptionsProps = {
  onRankPeriodChange: (value: ShareRankPeriod) => void;
  onVisibleStatToggle: (value: ShareStatId) => void;
  rankEnabled: boolean;
  rankPeriod: ShareRankPeriod;
  visibleStats: ShareStatId[];
};

export function ShareDisplayOptions({
  rankPeriod,
  visibleStats,
  onRankPeriodChange,
  onVisibleStatToggle,
  rankEnabled,
}: ShareDisplayOptionsProps) {
  return (
    <div className="space-y-4">
      <ShareRankPeriodPicker
        disabled={!rankEnabled}
        value={rankPeriod}
        onChange={onRankPeriodChange}
      />
      <ShareStatPicker
        rankEnabled={rankEnabled}
        selected={visibleStats}
        onToggle={onVisibleStatToggle}
      />
    </div>
  );
}

function periodLabel(period: ShareRankPeriod) {
  if (period === "day") return copy("usage.period.day");
  if (period === "week") return copy("usage.period.week");
  if (period === "month") return copy("usage.period.month");
  return copy("usage.period.total");
}

function statLabel(id: ShareStatId) {
  if (id === "total_tokens") return copy("share.card.identity.total_tokens");
  if (id === "estimated_cost") return copy("share.card.identity.estimated_cost");
  if (id === "active_days") return copy("share.card.identity.active_days");
  if (id === "longest_streak") return copy("share.card.identity.longest_streak");
  if (id === "top_model") return copy("share.card.identity.top_model");
  if (id === "top_model_share") return copy("share.card.identity.top_model_share");
  if (id === "avg_daily_tokens") return copy("share.card.identity.avg_daily_tokens");
  if (id === "avg_daily_cost") return copy("share.card.identity.avg_daily_cost");
  if (id === "recorded_days") return copy("share.card.identity.recorded_days");
  if (id === "tracked_since") return copy("share.card.identity.tracked_since");
  if (id === "period") return copy("share.card.identity.period");
  return copy("share.card.identity.global_rank");
}

function ShareRankPeriodPicker({
  disabled,
  value,
  onChange,
}: {
  disabled: boolean;
  value: ShareRankPeriod;
  onChange: (value: ShareRankPeriod) => void;
}) {
  return (
    <div>
      <div className="mb-2.5 text-[11px] tracking-[0.16em] uppercase text-oai-gray-500 dark:text-oai-gray-400">
        {copy("share.modal.rank_period_label")}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {SHARE_RANK_PERIODS.map((period) => (
          <RankPeriodButton
            key={period}
            active={value === period}
            disabled={disabled}
            period={period}
            onClick={() => onChange(period)}
          />
        ))}
      </div>
    </div>
  );
}

function RankPeriodButton({
  active,
  disabled,
  period,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  period: ShareRankPeriod;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={disabled ? copy("share.modal.rank_login_required") : undefined}
      onClick={onClick}
      className={[
        "rounded-md border px-2.5 py-2 text-[12px] tracking-[-0.01em] font-medium transition-colors",
        disabled
          ? "border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-400 dark:text-oai-gray-600 opacity-55 cursor-not-allowed"
          : active
            ? "border-oai-black dark:border-oai-white bg-oai-black dark:bg-oai-white text-white dark:text-oai-black"
            : "border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-700 dark:text-oai-gray-300 hover:border-oai-gray-400 dark:hover:border-oai-gray-600",
      ].join(" ")}
    >
      {periodLabel(period)}
    </button>
  );
}

function ShareStatPicker({
  rankEnabled,
  selected,
  onToggle,
}: {
  rankEnabled: boolean;
  selected: ShareStatId[];
  onToggle: (value: ShareStatId) => void;
}) {
  const selectedSet = new Set(selected);
  const atMax = SHARE_CARD_MAX_VISIBLE_STATS <= selected.length;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] tracking-[0.18em] uppercase text-oai-gray-500 dark:text-oai-gray-400">
          {copy("share.modal.stats_label")}
        </span>
        <span className="text-[11px] tabular-nums tracking-[-0.01em] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("share.modal.stats_count", {
            count: selected.length,
            max: SHARE_CARD_MAX_VISIBLE_STATS,
          })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {SHARE_STAT_OPTIONS.map((option) => (
          <StatToggleButton
            key={option.id}
            active={selectedSet.has(option.id)}
            disabled={shouldDisableStat(option.id, selectedSet.has(option.id), atMax, rankEnabled)}
            label={statLabel(option.id)}
            title={statDisabledTitle(option.id, selectedSet.has(option.id), atMax, rankEnabled)}
            onClick={() => onToggle(option.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StatToggleButton({
  active,
  disabled,
  label,
  title,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={[
        "rounded-full border px-3 py-1.5 text-[12px] tracking-[-0.01em] font-medium transition-colors",
        active
          ? "border-oai-black dark:border-oai-white bg-oai-black dark:bg-oai-white text-white dark:text-oai-black"
          : "border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-300 hover:border-oai-gray-400 dark:hover:border-oai-gray-600",
        disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function shouldDisableStat(id: ShareStatId, active: boolean, atMax: boolean, rankEnabled: boolean) {
  if (id === "rank" && !rankEnabled) return true;
  return !active && atMax;
}

function statDisabledTitle(id: ShareStatId, active: boolean, atMax: boolean, rankEnabled: boolean) {
  if (id === "rank" && !rankEnabled) return copy("share.modal.rank_login_required");
  if (!active && atMax) return copy("share.modal.stats_limit_reached");
  return undefined;
}
