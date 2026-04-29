import React, { useMemo, useRef, useEffect } from "react";
import { buildActivityHeatmap } from "../../../lib/activity-heatmap";
import { copy } from "../../../lib/copy";
import { useTheme } from "../../../hooks/useTheme.js";

const CELL_SIZE = 12;
const CELL_GAP = 3;
const LABEL_WIDTH = 26;

const HEATMAP_COLORS_LIGHT = [
  "#ebedf0", // level 0 - inactive, GitHub-style neutral
  "#a7f3d0", // level 1
  "#6ee7b7", // level 2
  "#34d399", // level 3
  "#10b981", // level 4
];

const HEATMAP_COLORS_DARK = [
  "#30363d", // level 0 - inactive, GitHub-style neutral
  "#065f46", // level 1
  "#059669", // level 2
  "#10b981", // level 3
  "#34d399", // level 4 - brightest
];

const MONTH_LABELS = [
  copy("heatmap.month.jan"),
  copy("heatmap.month.feb"),
  copy("heatmap.month.mar"),
  copy("heatmap.month.apr"),
  copy("heatmap.month.may"),
  copy("heatmap.month.jun"),
  copy("heatmap.month.jul"),
  copy("heatmap.month.aug"),
  copy("heatmap.month.sep"),
  copy("heatmap.month.oct"),
  copy("heatmap.month.nov"),
  copy("heatmap.month.dec"),
];

function formatTokenValue(value) {
  if (typeof value === "bigint") return value.toLocaleString();
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n).toLocaleString() : value;
  }
  return "0";
}

function parseUtcDate(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function diffUtcDays(a, b) {
  return Math.floor(
    (Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
      Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) /
      86400000
  );
}

function getWeekStart(date, weekStartsOn) {
  const desired = weekStartsOn === "mon" ? 1 : 0;
  const dow = date.getUTCDay();
  return addUtcDays(date, -((dow - desired + 7) % 7));
}

function buildMonthMarkers(weeksCount, to, weekStartsOn) {
  if (!weeksCount) return [];
  const end = parseUtcDate(to) || new Date();
  const months = [];
  for (let i = 11; i >= 0; i -= 1) {
    months.push(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)));
  }

  const endWeekStart = getWeekStart(end, weekStartsOn);
  const startAligned = addUtcDays(endWeekStart, -(weeksCount - 1) * 7);

  const markers = [];
  const used = new Set();
  for (const month of months) {
    const idx = Math.floor(diffUtcDays(startAligned, month) / 7);
    if (idx < 0 || idx >= weeksCount || used.has(idx)) continue;
    used.add(idx);
    markers.push({ label: MONTH_LABELS[month.getUTCMonth()], index: idx });
  }
  return markers;
}

export function ActivityHeatmap({
  heatmap,
  timeZoneLabel,
  timeZoneShortLabel,
  hideLegend = false,
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const heatmapColors = isDark ? HEATMAP_COLORS_DARK : HEATMAP_COLORS_LIGHT;
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [heatmap?.weeks]);

  const weekStartsOn = heatmap?.week_starts_on === "mon" ? "mon" : "sun";

  const normalized = useMemo(() => {
    const source = Array.isArray(heatmap?.weeks) ? heatmap.weeks : [];
    if (!source.length) return { weeks: [] };

    const rows = [];
    for (const week of source) {
      for (const cell of Array.isArray(week) ? week : []) {
        if (!cell?.day) continue;
        rows.push({
          day: cell.day,
          total_tokens: cell.total_tokens ?? cell.value ?? 0,
          billable_total_tokens: cell.billable_total_tokens ?? cell.value ?? cell.total_tokens ?? 0,
        });
      }
    }

    return buildActivityHeatmap({
      dailyRows: rows,
      weeks: Math.max(52, source.length),
      to: heatmap?.to,
      weekStartsOn,
    });
  }, [heatmap?.to, heatmap?.weeks, weekStartsOn]);

  const weeks = normalized?.weeks || [];

  const dayLabels =
    weekStartsOn === "mon"
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`))
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`));

  const monthMarkers = useMemo(
    () => buildMonthMarkers(weeks.length, normalized?.to, weekStartsOn),
    [normalized?.to, weeks.length, weekStartsOn]
  );

  if (!weeks.length) {
    return (
      <div className="py-8 text-center text-sm text-oai-gray-500">
        {copy("heatmap.empty")}
      </div>
    );
  }

  const gridCols = LABEL_WIDTH + weeks.length * CELL_SIZE + Math.max(0, weeks.length - 1) * CELL_GAP;

  return (
    <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("heatmap.title")}
        </h3>
        <span className="text-xs text-oai-gray-400 dark:text-oai-gray-400">{timeZoneShortLabel || copy("heatmap.legend.utc")}</span>
      </div>

      {/* Heatmap — scroll to latest (rightmost) on mount */}
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden heatmap-scroll-thin"
      >
        <div style={{ minWidth: gridCols }}>
          {/* Month labels */}
          <div
            className="grid text-[10px] uppercase text-oai-gray-400 dark:text-oai-gray-400 mb-1"
            style={{
              gridTemplateColumns: `${LABEL_WIDTH}px repeat(${weeks.length}, ${CELL_SIZE}px)`,
              columnGap: CELL_GAP,
            }}
          >
            <span />
            {monthMarkers.map((m) => (
              <span key={`${m.label}-${m.index}`} style={{ gridColumnStart: m.index + 2 }} className="whitespace-nowrap">
                {m.label}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: `${LABEL_WIDTH}px repeat(${weeks.length}, ${CELL_SIZE}px)`,
              columnGap: CELL_GAP,
            }}
          >
            {/* Day labels */}
            <div
              className="grid text-[10px] text-oai-gray-400 dark:text-oai-gray-400 sticky left-0 bg-white dark:bg-oai-gray-900 pr-2"
              style={{ gridTemplateRows: `repeat(7, ${CELL_SIZE}px)`, rowGap: CELL_GAP }}
            >
              {dayLabels.map((l) => (
                <span key={l} className="leading-none">
                  {l}
                </span>
              ))}
            </div>

            {/* Cells */}
            <div
              className="grid"
              style={{
                gridAutoFlow: "column",
                gridTemplateRows: `repeat(7, ${CELL_SIZE}px)`,
                gap: CELL_GAP,
              }}
            >
              {weeks.map((week, wi) =>
                (Array.isArray(week) ? week : []).map((cell, di) => {
                  if (!cell) return null;
                  const key = cell.day || `e-${wi}-${di}`;
                  const level = Number(cell.level) || 0;
                  const color = heatmapColors[level] || heatmapColors[0];
                  const tz = timeZoneLabel || timeZoneShortLabel || copy("heatmap.legend.utc");
                  return (
                    <span
                      key={key}
                      title={copy("heatmap.tooltip", {
                        day: cell.day,
                        value: formatTokenValue(cell.value),
                        unit: copy("heatmap.unit.tokens"),
                        tz,
                      })}
                      className="rounded-[2px] transition-transform hover:scale-125 hover:z-10"
                      style={{ width: CELL_SIZE, height: CELL_SIZE, background: color }}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      {!hideLegend && (
        <div className="flex items-center justify-center gap-2 mt-3">
          <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400">{copy("heatmap.legend.less")}</span>
          <div className="flex gap-0.5">
            {heatmapColors.map((c, i) => (
              <span key={i} className="rounded-[1px]" style={{ width: 10, height: 10, background: c }} />
            ))}
          </div>
          <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400">{copy("heatmap.legend.more")}</span>
        </div>
      )}
    </div>
  );
}
