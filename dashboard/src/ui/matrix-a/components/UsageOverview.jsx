import React, { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Info, SquareArrowOutUpRight } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Card, Button, Counter } from "../../openai/components";
import { useTheme } from "../../../hooks/useTheme.js";
import { copy } from "../../../lib/copy";
import { DateRangePopover, formatDateShort } from "./DateRangePopover.jsx";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { formatCompactNumber, formatUsdCurrency } from "../../../lib/format";
import { ContextBreakdownPanel } from "./ContextBreakdownPanel.jsx";

function formatTokens(value) {
  if (!Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (n <= 0) return null;
  return formatCompactNumber(n, { decimals: 1 });
}

function formatCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 0.01) return "<$0.01";
  return formatUsdCurrency(n.toFixed(2), { decimals: 2 });
}

function normalizePeriods(periods) {
  if (!Array.isArray(periods)) return [];
  return periods.map((p) => {
    if (typeof p === "string") {
      return { key: p, label: getPeriodLabel(p) };
    }
    return { key: p.key, label: p.label || getPeriodLabel(p.key) };
  });
}

function parseAnimatedCounterValue(displayValue) {
  if (typeof displayValue !== "string") return null;
  const match = displayValue.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// Provider color mapping for visual distinction
const PROVIDER_COLORS = {
  CODEX: "#10b981",     // emerald-500
  CLAUDE: "#8b5cf6",    // violet-500
  OPENCODE: "#f59e0b",  // amber-500
  GEMINI: "#3b82f6",    // blue-500
  KIMI: "#a78bfa",      // violet-400
};

function getProviderColor(label, index) {
  const normalized = label?.toUpperCase?.() || "";
  return PROVIDER_COLORS[normalized] || `hsl(${150 + index * 40}, 60%, 45%)`;
}

const PERIOD_COPY_KEYS = {
  day: "usage.period.day",
  week: "usage.period.week",
  month: "usage.period.month",
  total: "usage.period.total",
  custom: "usage.period.custom",
};

function getPeriodLabel(key) {
  const copyKey = PERIOD_COPY_KEYS[key];
  return copyKey ? copy(copyKey) : String(key).toUpperCase();
}

// Refresh button with rotation animation
function RefreshButton({ loading, onClick }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={loading}
      onClick={onClick}
      aria-label={copy("usage.button.refresh")}
      className="w-8 p-0"
    >
      <motion.span
        aria-hidden="true"
        animate={loading ? { rotate: 360 } : { rotate: 0 }}
        transition={
          loading && !shouldReduceMotion
            ? { duration: 1, repeat: Infinity, ease: "linear" }
            : { duration: 0.3 }
        }
        style={{ display: "inline-block" }}
      >
        ↻
      </motion.span>
    </Button>
  );
}

export function UsageOverview({
  period,
  periods,
  onPeriodChange,
  summaryValue,
  summaryLabel,
  summaryCostValue,
  onCostInfo,
  fleetData = [],
  onRefresh,
  loading,
  className = "",
  customFrom,
  customTo,
  onCustomRangeApply,
  customRangeOpen,
  onCustomRangeOpenChange,
  onOpenShare,
  from,
  to,
}) {
  const tabs = normalizePeriods(periods);
  const summaryCounterValue = parseAnimatedCounterValue(String(summaryValue ?? ""));
  const showAnimatedSummary = summaryCounterValue != null;
  const [expandedProvider, setExpandedProvider] = useState(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const gradientFrom = isDark ? "rgba(10,10,10,0.98)" : "rgba(255,255,255,0.96)";
  const gradientTo = isDark ? "rgba(10,10,10,0)" : "rgba(255,255,255,0)";

  // FleetData is already grouped by provider
  const providers = fleetData.filter((f) => f.models?.length > 0);

  return (
    <Card className={className}>
        {/* Header: Period Tabs + Refresh */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <div role="tablist" aria-label={copy("usage.overview.tablist_aria")} className="flex gap-1">
            {tabs.map((p) => {
              const isActive = period === p.key;
              const tabClass = `text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                isActive
                  ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                  : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800"
              }`;

              if (p.key === "custom") {
                const customLabel = isActive && customFrom && customTo
                  ? `${formatDateShort(customFrom)} — ${formatDateShort(customTo)}`
                  : p.label;

                return (
                  <Popover.Root
                    key="custom"
                    open={customRangeOpen}
                    onOpenChange={(open) => {
                      if (open) onPeriodChange?.("custom");
                      else onCustomRangeOpenChange?.(open);
                    }}
                  >
                    <Popover.Trigger
                      render={
                        <button
                          role="tab"
                          aria-selected={isActive}
                          type="button"
                          className={tabClass}
                        />
                      }
                    >
                      {customLabel}
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Positioner sideOffset={8} side="bottom" align="start" className="!z-[9999]">
                        <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                          <DateRangePopover
                            from={customFrom}
                            to={customTo}
                            onApply={onCustomRangeApply}
                            onCancel={() => onCustomRangeOpenChange?.(false)}
                          />
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                );
              }

              return (
                <button
                  key={p.key}
                  role="tab"
                  aria-selected={isActive}
                  type="button"
                  className={tabClass}
                  onClick={() => onPeriodChange?.(p.key)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
{onOpenShare ? (
              <button
                type="button"
                onClick={onOpenShare}
                aria-label={copy("share.button.aria")}
                className="inline-flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-oai-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white hover:border-oai-brand hover:text-oai-brand transition-colors duration-200"
              >
                <SquareArrowOutUpRight className="h-3.5 w-3.5" strokeWidth={2} />
                {copy("share.button.label")}
              </button>
            ) : null}
            {onRefresh && (
              <RefreshButton loading={loading} onClick={onRefresh} />
            )}
          </div>
        </div>

        {/* Main Stats */}
        <div className="text-center mb-8">
          <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wider mb-3">{summaryLabel}</div>
          <div className="text-6xl md:text-7xl font-bold text-oai-black dark:text-oai-white tracking-tight tabular-nums">
            {showAnimatedSummary ? (
              <Counter
                value={summaryCounterValue}
                displayValue={summaryValue}
                fontSize={72}
                padding={6}
                gap={1}
                textColor="var(--oai-black, #111827)"
                fontWeight={700}
                gradientHeight={isDark ? 0 : 8}
                gradientFrom={gradientFrom}
                gradientTo={gradientTo}
                counterStyle={{ paddingLeft: 0, paddingRight: 0, gap: 0 }}
                digitStyle={{ width: "0.88ch" }}
              />
            ) : (
              summaryValue
            )}
          </div>
          {summaryCostValue && (
            <div className="flex items-center justify-center gap-2 mt-4">
              {onCostInfo ? (
                <button
                  type="button"
                  onClick={onCostInfo}
                  className="inline-flex items-center gap-1.5 text-xl font-bold text-oai-brand hover:text-oai-brand-dark dark:hover:text-oai-brand-light transition-colors cursor-pointer"
                  aria-label={copy("usage.overview.cost_breakdown_aria")}
                >
                  {summaryCostValue}
                  <Info size={16} strokeWidth={2} className="opacity-80" />
                </button>
              ) : (
                <span className="text-xl font-bold text-oai-brand">{summaryCostValue}</span>
              )}
            </div>
          )}
        </div>

        {/* Provider Distribution */}
        {providers.length > 0 && (
          <div className="space-y-6">
            {/* Distribution Bar */}
            <div
              role="img"
              aria-label={copy("usage.overview.distribution_aria", {
                items: providers
                  .map((provider) =>
                    copy("usage.overview.distribution_item", {
                      label: provider.label,
                      percent: provider.totalPercent,
                    }),
                  )
                  .join("，"),
              })}
              className="h-1.5 w-full bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden flex"
            >
              {providers.map((provider, idx) => {
                const color = getProviderColor(provider.label, idx);
                return (
                  <motion.div
                    key={provider.label}
                    initial={{ width: 0 }}
                    animate={{ width: `${provider.totalPercent}%` }}
                    transition={{ duration: 0.5, delay: 0.45 + idx * 0.04, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full"
                    style={{ backgroundColor: color }}
                    title={`${provider.label}: ${provider.totalPercent}%`}
                  />
                );
              })}
            </div>

            {/* Provider Cards — responsive grid keeps cells equal-width so the
                last row never stretches when the count doesn't divide evenly. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
              {providers.map((provider, idx) => {
                const color = getProviderColor(provider.label, idx);
                const isExpanded = expandedProvider === provider.label;

                return (
                  <button
                    key={provider.label}
                    aria-expanded={isExpanded}
                    aria-controls={`provider-details-${provider.label}`}
                    aria-label={copy("usage.overview.provider_card_aria", {
                      provider: provider.label,
                      percent: provider.totalPercent,
                      tokens: formatTokens(provider.usage) || "0",
                      cost: formatCost(provider.usd) || "$0",
                      action: copy(isExpanded ? "usage.overview.collapse" : "usage.overview.expand"),
                    })}
                    onClick={() => setExpandedProvider(isExpanded ? null : provider.label)}
                    className={`min-w-0 text-left p-3 rounded-lg border transition-colors duration-200 ${
                      isExpanded
                        ? "border-oai-gray-300 dark:border-oai-gray-600 bg-oai-gray-50 dark:bg-oai-gray-800"
                        : "border-oai-gray-200 dark:border-oai-gray-700 hover:border-oai-gray-300 dark:hover:border-oai-gray-600"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <ProviderIcon provider={provider.label} size={15} color={color} className="text-oai-gray-700 dark:text-oai-gray-300 shrink-0" />
                      <span className="text-sm font-medium text-oai-black dark:text-oai-white">{provider.label}</span>
                    </div>
                    <div className="text-lg font-semibold text-oai-black dark:text-oai-white tabular-nums">
                      {provider.totalPercent}%
                    </div>
                    <div className="mt-0.5 text-[11px] text-oai-gray-400 dark:text-oai-gray-400 tabular-nums">
                      {copy("usage.overview.model_count", { count: provider.models.length })}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Expanded Provider Details */}
            {expandedProvider && (
              <div
                id={`provider-details-${expandedProvider}`}
                role="region"
                aria-label={copy("usage.overview.model_details_aria", {
                  provider: expandedProvider,
                })}
                className="mt-2"
              >
                {providers
                  .filter((p) => p.label === expandedProvider)
                  .map((provider) => {
                    const color = getProviderColor(provider.label, 0);
                    const sortedModels = [...provider.models].sort(
                      (a, b) => (b.share || 0) - (a.share || 0)
                    );

                    return (
                      <div key={provider.label}>
                        {/* Section header — provider identity only, nothing else */}
                        <div className="flex items-center gap-1.5 mb-3">
                          <ProviderIcon provider={provider.label} size={14} color={color} className="shrink-0" />
                          <span className="text-sm font-medium text-oai-black dark:text-oai-white">{provider.label}</span>
                        </div>

                        {/* Claude-only: Context Breakdown drill-down. Lives
                            inside the Claude expansion because no other
                            provider's logs carry the per-message role data
                            this requires. */}
                        {provider.label === "CLAUDE" ? (
                          <div className="mb-4 pb-4 border-b border-oai-gray-200 dark:border-oai-gray-700">
                            <ContextBreakdownPanel from={from} to={to} />
                          </div>
                        ) : null}

                        {/* Model rows — text line + thin muted bar as visual rhythm */}
                        <div className="space-y-3">
                          {sortedModels.map((model) => {
                            const tokensLabel = formatTokens(model.usage);
                            const costLabel = formatCost(model.cost);
                            const clampedShare = Math.max(0, Math.min(100, Number(model.share) || 0));
                            return (
                              <div key={model.id || model.name}>
                                <div className="flex items-baseline gap-4 mb-1.5">
                                  <span
                                    className="flex-1 min-w-0 text-sm text-oai-gray-700 dark:text-oai-gray-300 truncate"
                                    title={model.name}
                                  >
                                    {model.name}
                                  </span>
                                  <span className="shrink-0 w-16 text-right text-sm text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                                    {tokensLabel}
                                  </span>
                                  <span className="shrink-0 w-16 text-right text-sm text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                                    {costLabel}
                                  </span>
                                  <span className="shrink-0 w-12 text-right text-sm text-oai-black dark:text-oai-white tabular-nums">
                                    {model.share}%
                                  </span>
                                </div>
                                <div
                                  className="h-[3px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden"
                                  role="progressbar"
                                  aria-valuenow={clampedShare}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                >
                                  <div
                                    className="h-full transition-[width] duration-500 ease-out"
                                    style={{
                                      width: `${clampedShare}%`,
                                      backgroundColor: color,
                                      opacity: 0.45,
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

          </div>
        )}
      </Card>
  );
}
