import React, { useMemo, useRef, useEffect, useState } from "react";
import { buildActivityHeatmap } from "../../../lib/activity-heatmap";
import { copy } from "../../../lib/copy";
import { useTheme } from "../../../hooks/useTheme.js";
import { formatCompactNumber } from "../../../lib/format";
import { ActivityHeatmap3D, PALETTES, getAITooltipMessage } from "./ActivityHeatmap3D";
import { Maximize2, RotateCcw, X, Flame, Terminal, TrendingUp, Info, Play, Pause } from "lucide-react";

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

// Compact heatmap display — defers to the project-wide formatter for
// suffix/decimal consistency with StatsPanel / UsageOverview / etc., and
// falls back to localized `toLocaleString()` for <1k so small daily totals
// keep thousand separators ("999" stays "999", not "999.00").
function formatCompactTokenValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  if (num < 1000) return num.toLocaleString();
  return formatCompactNumber(num, { decimals: 2 });
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

function buildMonthMarkers(weeksCount, to, weekStartsOn, monthLabels) {
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
    markers.push({ label: monthLabels[month.getUTCMonth()], index: idx });
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
  const mainContainerRef = useRef(null);
  
  // 2D 精致 Hover 状态
  const [hoveredCell, setHoveredCell] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0, shiftX: 0 });
  const hideTimeoutRef = useRef(null);

  // 卸载时回收防抖定时器
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);
  
  // 3D 弹窗与控制状态
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [modalAutoRotate, setModalAutoRotate] = useState(false);
  const resetViewRef = useRef(null);
  const [activePalette, setActivePalette] = useState("emerald");

  // 动态感知多语言月份 labels
  const monthLabels = [
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

  const handleCellMouseEnter = (e, cell) => {
    if (!cell || !cell.day) return;
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setHoveredCell(cell);

    const rect = e.currentTarget.getBoundingClientRect();
    const container = mainContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    const y = rect.top - containerRect.top;

    // 自适应横向防溢出边界计算（Tooltip 卡片最大半宽约 140 像素）
    const halfWidth = 140;
    let shiftX = 0;
    if (x < halfWidth) {
      shiftX = halfWidth - x;
    } else if (x > containerRect.width - halfWidth) {
      shiftX = (containerRect.width - halfWidth) - x;
    }

    setTooltipPos({ x, y, shiftX });
  };

  const handleCellMouseLeave = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredCell(null);
    }, 150);
  };

  const handleTooltipMouseEnter = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const handleTooltipMouseLeave = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredCell(null);
    }, 150);
  };

  const handleOpenModal = () => {
    setIsClosing(false);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsClosing(true);
  };

  const handleAnimationEnd = (e) => {
    // 仅响应最外层 Backdrop div 自身的退场动画结束事件，进行 DOM 卸载与状态清理
    if (e.target === e.currentTarget && isClosing) {
      setIsModalOpen(false);
      setIsClosing(false);
    }
  };

  // 监听全局键盘事件，按 Escape 键优雅退场
  useEffect(() => {
    if (!isModalOpen || isClosing) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        handleCloseModal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isModalOpen, isClosing]);

  const paletteAccents = useMemo(() => ({
    emerald: {
      accentText: "text-emerald-500 dark:text-emerald-400",
      accentBg: "bg-emerald-500/10 dark:bg-emerald-400/10",
      accentBorder: "border-emerald-500/20 dark:border-emerald-400/15",
      hoverBorder: "hover:border-emerald-500/30 dark:hover:border-emerald-400/30",
      hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(16,185,129,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(52,211,153,0.25)]",
      rawColor: "#10b981"
    },
    ocean: {
      accentText: "text-blue-500 dark:text-blue-400",
      accentBg: "bg-blue-500/10 dark:bg-blue-400/10",
      accentBorder: "border-blue-500/20 dark:border-blue-400/15",
      hoverBorder: "hover:border-blue-500/30 dark:hover:border-blue-400/30",
      hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(59,130,246,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(96,165,250,0.25)]",
      rawColor: "#3b82f6"
    },
    neon: {
      accentText: "text-purple-500 dark:text-purple-400",
      accentBg: "bg-purple-500/10 dark:bg-purple-400/10",
      accentBorder: "border-purple-500/20 dark:border-purple-400/15",
      hoverBorder: "hover:border-purple-500/30 dark:hover:border-purple-400/30",
      hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(168,85,247,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(192,132,252,0.25)]",
      rawColor: "#a855f7"
    },
    amber: {
      accentText: "text-amber-500 dark:text-amber-400",
      accentBg: "bg-amber-500/10 dark:bg-amber-400/10",
      accentBorder: "border-amber-500/20 dark:border-amber-400/15",
      hoverBorder: "hover:border-amber-500/30 dark:hover:border-amber-400/30",
      hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(245,158,11,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(245,158,11,0.25)]",
      rawColor: "#f59e0b"
    }
  }), []);

  const activeAccent = paletteAccents[activePalette] || paletteAccents.emerald;
  const activeAccentColors = PALETTES[activePalette] 
    ? (isDark ? PALETTES[activePalette].dark : PALETTES[activePalette].light) 
    : (isDark ? PALETTES.emerald.dark : PALETTES.emerald.light);

  const [view, setView] = useState(() => {
    try {
      const stored = window.localStorage?.getItem("tt:heatmap-view");
      return stored === "3d" ? "3d" : "2d";
    } catch {
      return "2d";
    }
  });
  useEffect(() => {
    try { window.localStorage?.setItem("tt:heatmap-view", view); } catch { /* ignore */ }
  }, [view]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [heatmap?.weeks]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setHoveredCell(null);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

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
          models: cell.models ?? null,
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

  // 动态计算年度 Token 洞察统计数据
  const stats = useMemo(() => {
    let totalTokens = 0;
    let activeDays = 0;
    let maxSingleDay = { day: "无数据", value: 0 };
    let currentStreak = 0;
    let maxStreak = 0;

    const allCells = [];
    weeks.forEach((w) => {
      (Array.isArray(w) ? w : []).forEach((c) => {
        if (c && c.day) {
          allCells.push(c);
        }
      });
    });
    allCells.sort((a, b) => a.day.localeCompare(b.day));

    allCells.forEach((c) => {
      const val = Number(c.value) || 0;
      totalTokens += val;
      if (val > 0) {
        activeDays++;
        currentStreak++;
        if (currentStreak > maxStreak) {
          maxStreak = currentStreak;
        }
      } else {
        currentStreak = 0;
      }
      if (val > maxSingleDay.value) {
        maxSingleDay = { day: c.day, value: val };
      }
    });

    const totalDays = allCells.length || 365;
    const activeRate = totalDays ? ((activeDays / totalDays) * 100).toFixed(1) : "0.0";

    // AI 年度高阶技术人文评述 (去除塑料感，融入工程师深度共情)
    let aiEvaluationKey = "heatmap.3d.modal.ai.eval.default";
    let aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.default";

    if (totalTokens >= 15000000) {
      aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.peak";
      aiEvaluationKey = "heatmap.3d.modal.ai.eval.peak";
    } else if (totalTokens >= 5000000) {
      aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.heavy";
      aiEvaluationKey = "heatmap.3d.modal.ai.eval.heavy";
    } else if (totalTokens >= 1000000) {
      aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.core";
      aiEvaluationKey = "heatmap.3d.modal.ai.eval.core";
    } else if (totalTokens >= 20000) {
      aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.steady";
      aiEvaluationKey = "heatmap.3d.modal.ai.eval.steady";
    }

    // 取得年度总消耗费用（后端提供精准计算，前端针对 Mock 数据或历史缓存做备用估算兜底）
    const rawCost = heatmap?.total_cost_usd;
    const totalCostUsd = rawCost != null ? Number(rawCost) : (totalTokens / 1500000.0);

    return {
      totalTokens,
      activeDays,
      activeRate,
      maxSingleDay,
      maxStreak,
      aiEvaluationTitleKey,
      aiEvaluationKey,
      totalCostUsd,
    };
  }, [weeks, heatmap?.total_cost_usd]);

  const dayLabels =
    weekStartsOn === "mon"
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`))
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`));

  const monthMarkers = useMemo(
    () => buildMonthMarkers(weeks.length, normalized?.to, weekStartsOn, monthLabels),
    [normalized?.to, weeks.length, weekStartsOn, monthLabels]
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
    <div ref={mainContainerRef} className="relative rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("heatmap.title")}
        </h3>
        <div className="flex items-center gap-2">
          {/* View Tablist */}
          <div
            role="tablist"
            aria-label="Heatmap view"
            className="flex rounded-md border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 text-[10px]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "2d"}
              onClick={() => setView("2d")}
              className={
                view === "2d"
                  ? "px-2 py-0.5 rounded bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                  : "px-2 py-0.5 rounded text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200"
              }
            >
              {copy("heatmap.view.2d")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "3d"}
              onClick={() => setView("3d")}
              className={
                view === "3d"
                  ? "px-2 py-0.5 rounded bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                  : "px-2 py-0.5 rounded text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200"
              }
            >
              {copy("heatmap.view.3d")}
            </button>
          </div>



          <span className="text-xs text-oai-gray-400 dark:text-oai-gray-450">{timeZoneShortLabel || copy("heatmap.legend.utc")}</span>
        </div>
      </div>

      {view === "3d" && (
        <div 
          onClick={handleOpenModal} 
          className="cursor-pointer group relative overflow-hidden rounded-lg hover:border-oai-gray-350 dark:hover:border-oai-gray-700 border border-transparent transition-all"
          title={copy("heatmap.3d.hover_tip")}
        >
          <ActivityHeatmap3D weeks={weeks} isDark={isDark} palette={activePalette} />
          {/* Hover 提示微光遮罩 */}
          <div className="absolute inset-0 bg-gradient-to-t from-oai-gray-900/5 to-transparent pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
            <span className="text-[10px] bg-white/95 dark:bg-oai-gray-900/95 shadow border border-oai-gray-200/60 dark:border-oai-gray-800/80 px-2.5 py-1 rounded-full font-medium text-oai-gray-500 dark:text-oai-gray-400 flex items-center gap-1 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-200">
              <Maximize2 size={9} />
              {copy("heatmap.3d.hover_tip")}
            </span>
          </div>
        </div>
      )}


      {/* Heatmap — scroll to latest (rightmost) on mount */}
      {view === "2d" && (
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
                  return (
                    <span
                      key={key}
                      onMouseEnter={(e) => handleCellMouseEnter(e, cell)}
                      onMouseLeave={handleCellMouseLeave}
                      className="rounded-[2px] transition-transform hover:scale-125 hover:z-10 cursor-pointer"
                      style={{ width: CELL_SIZE, height: CELL_SIZE, background: color }}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
      )}

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

      {/* 3D Interactive Fullscreen Modal */}
      {isModalOpen && (
        <div 
          onAnimationEnd={handleAnimationEnd}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseModal();
          }}
          className={`fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 backdrop-blur-md bg-black/15 dark:bg-black/40 ${isClosing ? "animate-tt-fade-out" : "animate-tt-fade-in"}`}
        >
          {/* Modal Container */}
          <div className={`relative w-full max-w-6xl h-[88vh] backdrop-blur-2xl bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-white/10 shadow-2xl rounded-2xl flex flex-col md:flex-row overflow-hidden ${isClosing ? "animate-tt-modal-exit" : "animate-tt-modal"}`}>
            
            {/* Close Button */}
            <button
              type="button"
              onClick={handleCloseModal}
              className="absolute top-4 right-4 z-50 p-2 rounded-full border border-oai-gray-200/60 dark:border-oai-gray-800/60 bg-white/50 dark:bg-oai-gray-900/50 text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:rotate-90 hover:scale-105 active:scale-95 transition-all duration-300"
            >
              <X size={16} />
            </button>

            {/* Left Side: Stats and Controls */}
            <div className="w-full md:w-[340px] border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-6 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">
              
              {/* Header Badge & Title */}
              <div>
                <div className="flex items-center gap-1.5 select-none">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: activeAccent.rawColor }} />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: activeAccent.rawColor }} />
                  </span>
                  <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
                    3D Insight
                  </span>
                </div>
                <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-none mt-2 select-none">
                  {copy("heatmap.3d.modal.title")}
                </h4>
                <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500 mt-2 font-normal select-none">
                  {copy("heatmap.3d.modal.desc")}
                </p>
              </div>

              {/* Core Metrics Borderless Grid (Gallery Design) */}
              <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-y border-zinc-200/50 dark:border-zinc-800/50 py-5 select-none">
                
                {/* 1. Total Tokens */}
                <div className="flex flex-col gap-1 relative group cursor-help">
                  {/* Detailed Interactive Tooltip */}
                  <div className="absolute left-0 bottom-full mb-2 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                    <div className="bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 text-[10px] font-semibold font-mono rounded-lg px-2.5 py-1.5 shadow-xl border border-zinc-200 dark:border-zinc-800/80 whitespace-nowrap flex flex-col">
                      <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{copy("heatmap.3d.modal.stats.precision_total_tokens")}</span>
                      <span className="mt-0.5 font-bold text-zinc-900 dark:text-zinc-50">
                        {stats.totalTokens.toLocaleString()} Tokens
                      </span>
                    </div>
                  </div>

                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                    {copy("heatmap.3d.modal.stats.total_tokens")}
                  </span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                      {formatCompactTokenValue(stats.totalTokens)}
                    </span>
                    
                    {/* Compact Trend Line */}
                    <div className="opacity-30 group-hover:opacity-60 transition-opacity">
                      <svg width="24" height="10" viewBox="0 0 24 10" fill="none">
                        <path d="M1 9C3 7 5 7 7 4C9 1 11 0 13 2C15 4 17 0 23 0" stroke={activeAccent.rawColor} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* 2. Estimated Cost */}
                <div className="flex flex-col gap-1 group cursor-default">
                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                    {copy("heatmap.3d.modal.stats.estimated_cost")}
                  </span>
                  <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                    {"$" + stats.totalCostUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>

                {/* 3. Active Rate / Active Days */}
                <div className="flex flex-col gap-1 group cursor-default">
                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                    {copy("heatmap.3d.modal.stats.active_rate_days")}
                  </span>
                  <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                    {stats.activeRate}% <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono">({stats.activeDays}D)</span>
                  </span>
                </div>

                {/* 4. Active Streak */}
                <div className="flex flex-col gap-1 group cursor-default">
                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                    {copy("heatmap.3d.modal.stats.max_streak")}
                  </span>
                  <span className="text-xl font-black text-amber-500 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                    {stats.maxStreak} <span className="text-[10px] font-bold text-amber-500/80 font-mono">{copy("heatmap.3d.modal.stats.days_suffix")}</span>
                  </span>
                </div>

                {/* 5. Peak Day & Value */}
                <div className="flex flex-col gap-1 col-span-2 relative group cursor-help">
                  {/* Detailed Tooltip */}
                  <div className="absolute left-0 bottom-full mb-2 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                    <div className="bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 text-[10px] font-semibold font-mono rounded-lg px-2.5 py-1.5 shadow-xl border border-zinc-200 dark:border-zinc-800/80 whitespace-nowrap flex flex-col">
                      <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{copy("heatmap.3d.modal.stats.precision_peak_value")}</span>
                      <span className="mt-0.5 font-bold text-zinc-900 dark:text-zinc-50">
                        {stats.maxSingleDay.value > 0 ? stats.maxSingleDay.value.toLocaleString() : copy("heatmap.3d.modal.stats.no_data")} Tokens
                      </span>
                      <span className="text-[8px] text-zinc-400 dark:text-zinc-500 mt-0.5">{stats.maxSingleDay.day !== "无数据" ? stats.maxSingleDay.day : copy("heatmap.3d.modal.stats.no_data")}</span>
                    </div>
                  </div>

                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                    {copy("heatmap.3d.modal.stats.peak_day")}
                  </span>
                  <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                    {stats.maxSingleDay.value > 0 ? formatCompactTokenValue(stats.maxSingleDay.value) : copy("heatmap.3d.modal.stats.no_data")} <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono">({stats.maxSingleDay.day !== "无数据" ? stats.maxSingleDay.day : copy("heatmap.3d.modal.stats.no_data")})</span>
                  </span>
                </div>

              </div>

              {/* High-End Text Quote Analysis (Pure E-paper Blockquote Style) */}
              <div className="flex flex-col gap-2.5 py-1">
                <div className="flex items-center gap-1.5 select-none">
                  <Terminal size={11} style={{ color: activeAccent.rawColor }} />
                  <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono" style={{ color: activeAccent.rawColor }}>
                    {copy(stats.aiEvaluationTitleKey)}
                  </span>
                </div>
                
                <div 
                  className="pl-3.5 border-l-2 relative transition-all duration-300 group"
                  style={{ borderColor: activeAccent.rawColor }}
                >
                  {/* Subtle blur background reflection */}
                  <div className="absolute inset-y-0 left-0 w-[3px] blur-[2px] opacity-15 pointer-events-none rounded-full" style={{ backgroundColor: activeAccent.rawColor }} />
                  
                  <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 font-normal">
                    {copy(stats.aiEvaluationKey)}
                  </p>
                </div>
              </div>

              {/* Immersive Theme Accent Legend */}
              <div className="mt-auto border-t border-zinc-200/50 dark:border-zinc-800/50 pt-4 select-none">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                      {copy("heatmap.3d.modal.legend.title")}
                    </span>
                    <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                      {copy(`heatmap.3d.modal.palette.${activePalette}`)}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {activeAccentColors.map((color, idx) => (
                      <div key={idx} className="flex-1 h-1 rounded-[2px]" style={{ backgroundColor: color }} title={`Level ${idx}`} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Side: 3D Visualization Arena */}
            <div className="flex-1 h-full relative flex items-center justify-center overflow-hidden p-4">
              
              {/* Decorative Ambient Radial Glow Spheres */}
              <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full blur-[130px] pointer-events-none -translate-x-1/2 -translate-y-1/2 transition-all duration-500" style={{ backgroundColor: activeAccent.rawColor + "15" }} />
              <div className="absolute bottom-1/4 right-1/3 w-80 h-80 rounded-full blur-[120px] pointer-events-none translate-x-1/2 translate-y-1/2 bg-purple-500/[0.04] dark:bg-purple-500/[0.08]" />

              {/* Floating Interactive HUD Capsule */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 p-1.5 backdrop-blur-md bg-white/70 dark:bg-oai-gray-900/75 border border-oai-gray-200/60 dark:border-oai-gray-800/80 rounded-full shadow-lg z-30 select-none">
                {/* 1. Theme picker dots */}
                <div className="flex items-center gap-1.5 px-2">
                  {Object.keys(paletteAccents).map((key) => {
                    const isSelected = activePalette === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setActivePalette(key)}
                        title={copy(`heatmap.3d.modal.palette.${key}`)}
                        className={`w-3.5 h-3.5 rounded-full transition-all duration-200 relative hover:scale-125 ${
                          key === "emerald" ? "bg-[#10b981]" : key === "ocean" ? "bg-[#3b82f6]" : key === "neon" ? "bg-[#a855f7]" : "bg-[#f59e0b]"
                        }`}
                      >
                        {isSelected && (
                          <span className="absolute inset-0 rounded-full ring-2 ring-offset-1 ring-offset-white dark:ring-offset-oai-gray-900 ring-oai-gray-900 dark:ring-white scale-110" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Vertical Divider */}
                <div className="w-[1px] h-4 bg-oai-gray-200 dark:bg-oai-gray-800" />

                {/* 2. Controls */}
                <div className="flex items-center gap-1 pr-1">
                  {/* Auto Rotate Button */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = !modalAutoRotate;
                      setModalAutoRotate(next);
                      if (resetViewRef.current) resetViewRef.current.toggleAutoRotate(next);
                    }}
                    title={modalAutoRotate ? copy("heatmap.3d.modal.control.pause") : copy("heatmap.3d.modal.control.play")}
                    className={`p-1.5 rounded-full transition-all duration-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 ${
                      modalAutoRotate ? activeAccent.accentText : "text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-250"
                    }`}
                  >
                    {modalAutoRotate ? <Pause size={12} /> : <Play size={12} />}
                  </button>

                  {/* Reset View Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setModalAutoRotate(false);
                      if (resetViewRef.current) resetViewRef.current.reset();
                    }}
                    title={copy("heatmap.3d.modal.control.reset")}
                    className="p-1.5 rounded-full text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-250 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-all duration-200"
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
              </div>

              <ActivityHeatmap3D
                weeks={weeks}
                isDark={isDark}
                interactive={true}
                palette={activePalette}
                autoRotateInit={modalAutoRotate}
                onResetViewRef={resetViewRef}
              />
              
              {/* Corner tips */}
              <div className="absolute bottom-4 right-4 flex items-center gap-1.5 text-[9px] font-bold text-oai-gray-400 bg-white/80 dark:bg-oai-gray-900/80 border border-oai-gray-200/50 dark:border-oai-gray-800/80 rounded-md px-2.5 py-1.5 select-none pointer-events-none backdrop-blur-md shadow-sm">
                <Info size={10} className={activeAccent.accentText} />
                <span>{copy("heatmap.3d.modal.footer.tip")}</span>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* 2D 精致 Hover Tooltip */}
      {hoveredCell && !isModalOpen && (
        <div
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          className="absolute z-[9999] w-0 h-0 transition-all duration-100 ease-out"
          style={{
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
          }}
        >
          {/* Tooltip 玻璃外框（悬浮定位，底边固定在单元格上方） */}
          <div 
            className="absolute left-0 bottom-[10px] backdrop-blur-md bg-white/95 dark:bg-oai-gray-900/95 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[200px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100"
            style={{
              transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
            }}
          >
            {/* 顶栏 */}
            <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
              <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                {hoveredCell.day}
              </span>
              {(() => {
                const badgeColor = hoveredCell.level === 0 
                  ? (isDark ? "#9ca3af" : "#6b7280") 
                  : heatmapColors[hoveredCell.level];
                return (
                  <span 
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{
                      backgroundColor: badgeColor + "22",
                      color: badgeColor,
                      border: `1px solid ${badgeColor}44`
                    }}
                  >
                    Level {hoveredCell.level}
                  </span>
                );
              })()}
            </div>
            
            {/* 内容 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none">
                  {Number(hoveredCell.total_tokens ?? hoveredCell.value).toLocaleString()}
                </span>
                <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
                  Tokens
                </span>
              </div>
              
              {hoveredCell.models && Object.keys(hoveredCell.models).length > 0 ? (
                <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
                    Model Breakdown
                  </div>
                  <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 scrollbar-thin">
                    {Object.entries(hoveredCell.models)
                      .map(([name, val]) => ({ name, val: Number(val) }))
                      .sort((a, b) => b.val - a.val)
                      .map(({ name, val }) => {
                        const total = Number(hoveredCell.total_tokens ?? hoveredCell.value) || 1;
                        const pct = Math.round((val / total) * 100);
                        return (
                          <div key={name} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-[11px] gap-3">
                              <span className="font-medium text-oai-gray-750 dark:text-oai-gray-200 truncate max-w-[120px]" title={name}>
                                {name}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="font-mono text-oai-gray-900 dark:text-oai-gray-100 font-semibold">
                                  {val.toLocaleString()}
                                </span>
                                <span className="text-[9px] text-oai-gray-450 dark:text-oai-gray-500 min-w-[28px] text-right font-medium">
                                  {pct}%
                                </span>
                              </div>
                            </div>
                            <div className="w-full h-1 bg-oai-gray-100 dark:bg-oai-gray-800/85 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${pct}%`,
                                  backgroundColor: heatmapColors[4],
                                  boxShadow: `0 0 4px ${heatmapColors[4]}55`
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-oai-gray-600 dark:text-oai-gray-300 leading-relaxed font-normal mt-1 border-t border-dashed border-oai-gray-100 dark:border-oai-gray-800/60 pt-1.5">
                  {getAITooltipMessage(hoveredCell.level, hoveredCell.total_tokens ?? hoveredCell.value)}
                </p>
              )}
            </div>
          </div>
          
          {/* 倒三角小尾巴 */}
          <div 
            className="absolute bottom-[6px] left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 border-r border-b border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-sm"
            style={{ marginBottom: "1px" }}
          />
        </div>
      )}

      <style>{`
        .scrollbar-thin::-webkit-scrollbar {
          width: 4px;
          height: 4px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgba(156, 163, 175, 0.25);
          border-radius: 9999px;
          transition: background 0.2s ease;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgba(156, 163, 175, 0.45);
        }
        .dark .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgba(156, 163, 175, 0.18);
        }
        .dark .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgba(156, 163, 175, 0.3);
        }

        @keyframes tt-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes tt-fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes tt-modal-entrance {
          from { 
            opacity: 0; 
            transform: scale(0.96) translateY(10px); 
          }
          to { 
            opacity: 1; 
            transform: scale(1) translateY(0); 
          }
        }
        @keyframes tt-modal-exit {
          from { 
            opacity: 1; 
            transform: scale(1) translateY(0); 
          }
          to { 
            opacity: 0; 
            transform: scale(0.96) translateY(10px); 
          }
        }
        .animate-tt-fade-in {
          animation: tt-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .animate-tt-fade-out {
          animation: tt-fade-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .animate-tt-modal {
          animation: tt-modal-entrance 0.3s cubic-bezier(0.34, 1.3, 0.64, 1) forwards;
        }
        .animate-tt-modal-exit {
          animation: tt-modal-exit 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );
}

