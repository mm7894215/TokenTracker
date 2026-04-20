import React from "react";
import { copy } from "../../../lib/copy";
import { formatUsdCurrency } from "../../../lib/format";

export function BudgetAlertCard({ alert, onViewProject, className = "" }) {
  if (!alert) return null;

  const message = alert.status === "over"
    ? copy("dashboard.budget.alert.over", {
        total: formatUsdCurrency(alert.total) || "$0",
        budget: formatUsdCurrency(alert.budget) || "$0",
        percent: alert.overrunPct,
      })
    : copy("dashboard.budget.alert.forecast", {
        projected: formatUsdCurrency(alert.projected) || "$0",
        budget: formatUsdCurrency(alert.budget) || "$0",
        percent: alert.overrunPct,
      });

  return (
    <div className={`rounded-xl border border-amber-300/70 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 p-4 ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {copy("dashboard.budget.title")}
          </div>
          <div className="mt-1 text-sm text-amber-900 dark:text-amber-100 leading-6">
            {message}
          </div>
          {alert.topProject ? (
            <div className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
              {copy("dashboard.budget.top_project", { project: alert.topProject })}
            </div>
          ) : null}
        </div>
        {onViewProject ? (
          <button
            type="button"
            onClick={onViewProject}
            className="shrink-0 rounded-md border border-amber-400/60 dark:border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          >
            {copy("dashboard.budget.cta")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
