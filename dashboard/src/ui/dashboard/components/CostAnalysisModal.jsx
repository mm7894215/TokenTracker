import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import React, { useMemo } from "react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber, formatUsdCurrency, toFiniteNumber } from "../../../lib/format";

function formatHeroTotal(value) {
  if (!Number.isFinite(value)) return copy("shared.placeholder.short");
  const formatted = formatUsdCurrency(value.toFixed(2), { decimals: 2 });
  return formatted === "-" ? copy("shared.placeholder.short") : formatted;
}

function formatCostCell(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return "<$0.01";
  return formatUsdCurrency(value.toFixed(2), { decimals: 2 });
}

function formatTokensCell(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatCompactNumber(n, { decimals: 1 });
}

export const CostAnalysisModal = React.memo(function CostAnalysisModal({
  isOpen,
  onClose,
  fleetData = [],
}) {
  // Memoized so parent re-renders don't re-walk fleetData each tick
  const normalizedFleet = useMemo(() => {
    return (Array.isArray(fleetData) ? fleetData : [])
      .map((fleet) => {
        const usdValue = toFiniteNumber(fleet?.usd) ?? 0;
        const tokenValue = toFiniteNumber(fleet?.usage) ?? 0;
        const models = Array.isArray(fleet?.models) ? fleet.models : [];
        return {
          label: fleet?.label ? String(fleet.label) : "",
          usdValue,
          usdLabel: formatCostCell(usdValue),
          tokensLabel: formatTokensCell(tokenValue),
          models: models
            .map((model) => {
              const tokens = toFiniteNumber(model?.usage) ?? 0;
              const cost = toFiniteNumber(model?.cost) ?? 0;
              return {
                id: model?.id ? String(model.id) : "",
                name: model?.name ? String(model.name) : "",
                tokensLabel: formatTokensCell(tokens),
                costLabel: formatCostCell(cost),
                sortCost: cost,
              };
            })
            .filter((m) => m.costLabel || m.tokensLabel)
            .sort((a, b) => b.sortCost - a.sortCost),
        };
      })
      .filter((fleet) => fleet.usdValue > 0 || fleet.models.length > 0)
      .sort((a, b) => b.usdValue - a.usdValue);
  }, [fleetData]);

  const totalLabel = useMemo(() => {
    const totalUsd = normalizedFleet.reduce((acc, fleet) => acc + fleet.usdValue, 0);
    return formatHeroTotal(totalUsd);
  }, [normalizedFleet]);

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="cost-modal-backdrop" data-cost-analysis-backdrop="true" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="cost-modal-popup relative w-full max-w-[460px] max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl bg-white dark:bg-oai-gray-950 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden">
            {/* Modal purpose — visually hidden, announced by screen readers */}
            <Dialog.Title
              render={<h2 className="sr-only" />}
            >
              {copy("dashboard.cost_breakdown.title")}
            </Dialog.Title>

            <Dialog.Close
              type="button"
              className="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-md text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-800 dark:hover:text-oai-gray-100 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/50 transition-colors z-10"
              aria-label={copy("dashboard.cost_breakdown.close")}
            >
              <X size={16} strokeWidth={2} aria-hidden />
            </Dialog.Close>

            {/* Single scroll area wraps hero + list so all content shares one
                padding context and one scrollbar gutter — no alignment drift. */}
            <div className="flex-1 min-h-0 overflow-y-auto oai-scrollbar">
              <div className="px-3 py-6">
                {/* Hero */}
                <p className="text-label uppercase tracking-[0.12em] text-oai-gray-500 dark:text-oai-gray-400 mb-2">
                  {copy("dashboard.cost_breakdown.total_label")}
                </p>
                <p
                  className="font-bold text-oai-brand tabular-nums tracking-tight leading-none mb-6"
                  style={{ fontSize: "clamp(24px, 6.5vw, 32px)" }}
                >
                  {totalLabel}
                </p>

                {/* Fleet list — semantic ARIA table */}
                {normalizedFleet.length === 0 ? (
                  <p className="text-body-sm text-oai-gray-500 dark:text-oai-gray-400">
                    No spend recorded.
                  </p>
                ) : (
                  <div role="table" aria-label={copy("dashboard.cost_breakdown.title")}>
                  {/* Column headers */}
                  <div
                    role="row"
                    className="flex items-center justify-between gap-4 py-2 mb-2 border-b border-oai-gray-200 dark:border-oai-gray-800 text-label uppercase text-oai-gray-500 dark:text-oai-gray-400"
                  >
                    <span role="columnheader">Model</span>
                    <span role="columnheader">Cost</span>
                  </div>

                  {normalizedFleet.map((fleet, index) => {
                    const rowGroupId = `fleet-${index}`;
                    return (
                      <div
                        key={`${fleet.label}-${index}`}
                        role="rowgroup"
                        aria-labelledby={rowGroupId}
                        className={index > 0 ? "mt-5" : "mt-2"}
                      >
                        {/* Provider row */}
                        <div
                          role="row"
                          className="flex items-center justify-between gap-4 py-2"
                        >
                          <span
                            id={rowGroupId}
                            role="rowheader"
                            className="flex-1 min-w-0 text-body-sm font-semibold text-oai-black dark:text-oai-white truncate leading-none"
                          >
                            {fleet.label}
                          </span>
                          <span
                            role="cell"
                            className="shrink-0 text-body-sm font-semibold text-oai-black dark:text-oai-white tabular-nums leading-none"
                          >
                            {fleet.usdLabel || "—"}
                          </span>
                        </div>

                        {/* Model rows */}
                        {fleet.models.map((model, mi) => (
                          <div
                            key={model.id || `${model.name}-${mi}`}
                            role="row"
                            className="flex items-center justify-between gap-4 py-[5px]"
                          >
                            <span
                              role="cell"
                              className="flex-1 min-w-0 text-caption text-oai-gray-500 dark:text-oai-gray-400 truncate leading-none"
                              title={model.name}
                            >
                              {model.name}
                            </span>
                            <span
                              role="cell"
                              className="shrink-0 text-caption text-oai-gray-700 dark:text-oai-gray-300 tabular-nums leading-none"
                            >
                              {model.costLabel || ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  </div>
                )}
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
});
