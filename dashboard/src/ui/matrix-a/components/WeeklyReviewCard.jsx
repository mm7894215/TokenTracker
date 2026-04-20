import React, { useMemo } from "react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";
import { buildWeeklyReview } from "../../../lib/weekly-review.js";

function formatValue(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return copy("shared.placeholder.short");
  }
  return formatCompactNumber(value, {
    thousandSuffix: copy("shared.unit.thousand_abbrev"),
    millionSuffix: copy("shared.unit.million_abbrev"),
    billionSuffix: copy("shared.unit.billion_abbrev"),
  });
}

export function WeeklyReviewCard({
  dailyRows = [],
  projectEntries = [],
  topModels = [],
  className = "",
}) {
  const review = useMemo(
    () => buildWeeklyReview({ dailyRows, projectEntries, topModels }),
    [dailyRows, projectEntries, topModels],
  );

  return (
    <div className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 ${className}`}>
      <div className="mb-4">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("dashboard.weekly_review.title")}
        </h3>
        <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.weekly_review.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Metric
          label={copy("dashboard.weekly_review.total")}
          value={formatValue(review.total)}
        />
        <Metric
          label={copy("dashboard.weekly_review.previous")}
          value={formatValue(review.previousTotal)}
        />
        <Metric
          label={copy("dashboard.weekly_review.top_project")}
          value={review.topProject?.name || copy("shared.placeholder.short")}
          compact
        />
        <Metric
          label={copy("dashboard.weekly_review.top_model")}
          value={review.topModel?.name || copy("shared.placeholder.short")}
          compact
        />
      </div>

      <div className="mt-4 rounded-lg bg-oai-gray-50 dark:bg-oai-gray-800/70 px-3 py-3">
        <div className="text-[11px] uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.weekly_review.spike_label")}
        </div>
        <div className="mt-1 text-sm text-oai-black dark:text-oai-white">
          {review.topDay?.day
            ? copy("dashboard.weekly_review.spike_value", {
                day: review.topDay.day,
                tokens: formatValue(review.topDay.tokens),
              })
            : copy("dashboard.weekly_review.spike_empty")}
        </div>
      </div>

      <div className="mt-4 text-sm text-oai-gray-700 dark:text-oai-gray-300 leading-6">
        {copy(review.recommendationKey, review.recommendationValues)}
      </div>
    </div>
  );
}

function Metric({ label, value, compact = false }) {
  return (
    <div className="rounded-lg border border-oai-gray-100 dark:border-oai-gray-800 px-3 py-3">
      <div className="text-[11px] uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
        {label}
      </div>
      <div
        className={`mt-1 font-semibold text-oai-black dark:text-oai-white ${compact ? "text-sm truncate" : "text-lg"}`}
        title={compact ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}
