import React from "react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";
import { Card, Badge } from "../../components";

function normalizeBadgePart(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function toTitleWords(value) {
  const normalized = normalizeBadgePart(value);
  if (!normalized) return "";
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function buildSubscriptionItems(subscriptions) {
  if (!Array.isArray(subscriptions)) return [];
  const deduped = new Map();
  for (const entry of subscriptions) {
    if (!entry || typeof entry !== "object") continue;
    const toolRaw = normalizeBadgePart(entry.tool);
    const planRaw = normalizeBadgePart(entry.planType) || normalizeBadgePart(entry.plan_type);
    if (!toolRaw || !planRaw) continue;
    const tool = toTitleWords(toolRaw) || toolRaw;
    const plan = toTitleWords(planRaw) || planRaw;
    deduped.set(`${toolRaw.toLowerCase()}::${planRaw.toLowerCase()}`, { tool, plan });
  }
  return Array.from(deduped.values());
}

export function StatsPanel({
  period = "month",
  rankLabel,
  streakDays,
  subscriptions = [],
  periodConversations,
  rolling,
  topModels = [],
  className = "",
}) {
  const placeholder = copy("shared.placeholder.short");
  const percentSymbol = copy("shared.unit.percent");

  const rankValue = rankLabel ?? copy("identity_card.rank_placeholder");
  const streakDaysNum = Number.isFinite(Number(streakDays)) ? Number(streakDays) : 0;
  const streakValue = streakDaysNum
    ? copy("identity_card.streak_value", { days: streakDaysNum })
    : copy("identity_card.rank_placeholder");
  const subscriptionItems = buildSubscriptionItems(subscriptions);

  const compactConfig = {
    thousandSuffix: copy("shared.unit.thousand_abbrev"),
    millionSuffix: copy("shared.unit.million_abbrev"),
    billionSuffix: copy("shared.unit.billion_abbrev"),
  };
  const formatValue = (value) => {
    if (value == null) return placeholder;
    const formatted = formatCompactNumber(value, compactConfig);
    return formatted === "-" ? placeholder : formatted;
  };
  const periodConversationLabel = (() => {
    switch (period) {
      case "day":
        return copy("stats.period.today");
      case "week":
        return copy("stats.period.week");
      case "month":
        return copy("stats.period.month");
      case "total":
        return copy("stats.period.all");
      default:
        return copy("stats.period.convs");
    }
  })();

  const displayModels = topModels.slice(0, 3);

  return (
    <Card className={`h-full ${className}`}>
        {/* Rolling Stats */}
        <div className="grid grid-cols-4 gap-2">
          <div className="flex flex-col items-center justify-center px-2 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 rounded-lg">
            <span className="text-sm font-semibold text-oai-black dark:text-oai-white tabular-nums">
              {formatValue(rolling?.last_7d?.totals?.billable_total_tokens)}
            </span>
            <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400 mt-0.5 whitespace-nowrap">7d</span>
          </div>
          <div className="flex flex-col items-center justify-center px-2 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 rounded-lg">
            <span className="text-sm font-semibold text-oai-black dark:text-oai-white tabular-nums">
              {formatValue(rolling?.last_30d?.totals?.billable_total_tokens)}
            </span>
            <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400 mt-0.5 whitespace-nowrap">30d</span>
          </div>
          <div className="flex flex-col items-center justify-center px-2 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 rounded-lg">
            <span className="text-sm font-semibold text-oai-black dark:text-oai-white tabular-nums">
              {formatValue(rolling?.last_30d?.avg_per_active_day)}
            </span>
            <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400 mt-0.5 whitespace-nowrap">avg</span>
          </div>
          <div className="flex flex-col items-center justify-center px-2 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 rounded-lg">
            <span className="text-sm font-semibold text-oai-black dark:text-oai-white tabular-nums">
              {formatValue(periodConversations)}
            </span>
            <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400 mt-0.5 whitespace-nowrap">{periodConversationLabel}</span>
          </div>
        </div>

        {/* Top Models */}
        {displayModels.length > 0 && (
          <div className="mt-4 pt-3 border-t border-oai-gray-100 dark:border-oai-gray-800">
            {displayModels.map((row, index) => {
              const name = row?.name ? String(row.name) : placeholder;
              const percent = row?.percent ? String(row.percent) : "";
              const isLast = index === displayModels.length - 1;
              const rankNum = index + 1;

              return (
                <div
                  key={row.id || name}
                  className={`flex items-center py-2 ${!isLast ? "border-b border-oai-gray-50 dark:border-oai-gray-800" : ""}`}
                >
                  <span className="w-5 h-5 flex items-center justify-center rounded-full bg-oai-gray-100 dark:bg-oai-gray-800 text-[10px] font-semibold text-oai-gray-500 dark:text-oai-gray-300 flex-shrink-0">
                    {rankNum}
                  </span>
                  <span className="flex-1 text-sm text-oai-gray-700 dark:text-oai-gray-300 truncate px-2.5" title={name}>
                    {name}
                  </span>
                  <span className="text-sm font-semibold text-oai-black dark:text-oai-white tabular-nums flex-shrink-0">
                    {percent}{percentSymbol}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Subscriptions */}
        {subscriptionItems.length > 0 && (
          <div className="mt-3 pt-3 border-t border-oai-gray-100 dark:border-oai-gray-800 flex flex-wrap gap-1.5">
            {subscriptionItems.map((entry, index) => (
              <Badge
                key={`${entry.tool}:${entry.plan}:${index}`}
                variant="secondary"
                size="sm"
              >
                {entry.tool} {entry.plan}
              </Badge>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-oai-gray-100 dark:border-oai-gray-800 flex items-center justify-between text-xs text-oai-gray-400 dark:text-oai-gray-400">
          <div className="flex items-center gap-1.5">
            <span>{copy("identity_card.rank_label")}</span>
            <span className="text-oai-gray-500 dark:text-oai-gray-300 tabular-nums">{rankValue}</span>
          </div>
          <div className="flex items-center gap-1">
            <span>{copy("identity_card.streak_label")}</span>
            <span className="text-oai-gray-500 dark:text-oai-gray-300 tabular-nums">{streakValue}</span>
          </div>
        </div>
      </Card>
  );
}
