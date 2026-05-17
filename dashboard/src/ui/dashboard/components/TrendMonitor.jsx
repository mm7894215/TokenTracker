import React from "react";
import { motion, useReducedMotion } from "motion/react";
import { copy } from "../../../lib/copy";

function interpolateQuantile(sortedValues, ratio) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

export function getTrendMonitorScale(values) {
  const finiteValues = Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
    : [];

  if (finiteValues.length === 0) {
    return {
      rawMax: 0,
      effectiveMax: 1,
      clippedValues: Array.isArray(values) ? values.map(() => 0) : [],
    };
  }

  const rawMax = finiteValues.at(-1) ?? 0;
  let effectiveMax = rawMax;

  if (finiteValues.length >= 4) {
    const q1 = interpolateQuantile(finiteValues, 0.25);
    const q3 = interpolateQuantile(finiteValues, 0.75);
    const iqr = Math.max(q3 - q1, 0);
    const upperWhisker = q3 + iqr * 1.5;
    const hasOutlier = rawMax > upperWhisker;

    if (hasOutlier) {
      effectiveMax = Math.max(upperWhisker, q3, 1);
    }
  }

  return {
    rawMax,
    effectiveMax: Math.max(effectiveMax, 1),
    clippedValues: Array.isArray(values)
      ? values.map((value) => {
          if (!Number.isFinite(value) || value <= 0) return 0;
          return Math.min(value, Math.max(effectiveMax, 1));
        })
      : [],
  };
}

function TrendBar({ value, displayValue, scale, index, row, totalBars }) {
  const shouldReduceMotion = useReducedMotion();
  const heightPercent = scale.effectiveMax > 0 ? (displayValue / scale.effectiveMax) * 100 : 0;
  const barHeight = `${Math.max(heightPercent, 2)}%`;
  const isMissing = row?.missing;
  const isFuture = row?.future;
  const borderRadius = totalBars <= 7 ? "6px" : totalBars <= 14 ? "4px" : "3px";

  return (
    <motion.div
      className="group relative flex-1 self-stretch"
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{
        duration: shouldReduceMotion ? 0 : 0.3,
        delay: shouldReduceMotion ? 0 : 0.4 + index * 0.008,
        ease: [0.16, 1, 0.3, 1],
      }}
      style={{ originY: 1 }}
    >
      <div className="absolute inset-x-0 bottom-0" style={{ height: barHeight }}>
        <div
          data-trend-bar="true"
          className="h-full w-full cursor-pointer transition-all duration-200 group-hover:brightness-110"
          style={{
            minHeight: value > 0 ? "4px" : "2px",
            opacity: isMissing || isFuture ? 0.2 : 1,
            borderRadius: `${borderRadius} ${borderRadius} 0 0`,
            background: value > 0 ? "#10b981" : "var(--oai-gray-100)",
          }}
          title={`${value.toLocaleString()}`}
        />
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-oai-black text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20">
          {value.toLocaleString()}
        </div>
      </div>
    </motion.div>
  );
}

export function TrendMonitor({
  rows,
  from,
  to,
  period,
  timeZoneLabel,
  showTimeZoneLabel = true,
  className = "",
}) {
  const series = Array.isArray(rows) && rows.length ? rows : [];

  const seriesValues = series.map((row) => {
    if (row?.missing || row?.future) return 0;
    const raw = row?.billable_total_tokens ?? row?.total_tokens ?? row?.value;
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  });
  const scale = getTrendMonitorScale(seriesValues);

  return (
    <div className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 ${className}`}>
      <div className="mb-3">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("trend.monitor.label")}
        </h3>
        {showTimeZoneLabel && timeZoneLabel && (
          <p className="text-xs text-oai-gray-400 dark:text-oai-gray-400 mt-0.5">{timeZoneLabel}</p>
        )}
      </div>
      <div className="space-y-3">
        <div className="relative">
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {[0, 25, 50, 75, 100].map((pct) => (
              <div
                key={pct}
                className="w-full border-t border-oai-gray-100 dark:border-oai-gray-800"
                style={{ top: `${100 - pct}%` }}
              />
            ))}
          </div>
          <div className="h-40 flex items-end gap-1 relative z-0">
            {seriesValues.length > 0 ? (
              seriesValues.map((value, index) => (
                <TrendBar
                  key={index}
                  value={value}
                  displayValue={scale.clippedValues[index] ?? 0}
                  scale={scale}
                  index={index}
                  row={series[index]}
                  totalBars={seriesValues.length}
                />
              ))
            ) : (
              <div className="flex-1 h-full flex items-center justify-center">
                <p className="text-sm text-oai-gray-400 dark:text-oai-gray-400">No data yet</p>
              </div>
            )}
          </div>
        </div>

        {from && to && (
          <div className="flex justify-between text-xs text-oai-gray-500 dark:text-oai-gray-300 font-medium pt-2 border-t border-oai-gray-100 dark:border-oai-gray-800">
            <span>{from}</span>
            <span>{to}</span>
          </div>
        )}
      </div>
    </div>
  );
}
