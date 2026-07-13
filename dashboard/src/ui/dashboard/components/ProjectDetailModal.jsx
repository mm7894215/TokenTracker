import React from "react";
import { GitBranch, X } from "lucide-react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { formatCompactNumber, toDisplayNumber, toFiniteNumber } from "../../../lib/format";
import { useProjectUsageDetail } from "../../../hooks/use-project-usage-detail";
import { getLocalDayKey } from "../../../lib/timezone";
import { ProviderIcon } from "./ProviderIcon";
import { TrendMonitor, getModelColor } from "./TrendMonitor.jsx";
import {
  ProjectAvatar,
  forgeKindFromHost,
  githubOwnerFor,
  projectRefHost,
  splitProjectKey,
} from "./project-usage-utils.jsx";

// Shares the terminal-native inspection language of TrendMonitorZoomModal /
// the 3D heatmap insight modal, so every "zoom to inspect" surface reads as
// one family. ACCENT matches theirs.
const ACCENT = "#10b981";

// Same values as TrendMonitor's TOKEN_COLORS so token categories read as one
// system across the dashboard; cache write gets amber (not used there).
const COMPOSITION_SEGMENTS = [
  { key: "input_tokens", labelKey: "dashboard.projects.detail.comp_input", color: "#38bdf8" },
  { key: "cached_input_tokens", labelKey: "dashboard.projects.detail.comp_cached", color: "#14b8a6" },
  { key: "cache_creation_input_tokens", labelKey: "dashboard.projects.detail.comp_cache_write", color: "#f59e0b" },
  { key: "output_tokens", labelKey: "dashboard.projects.detail.comp_output", color: "#a78bfa" },
  { key: "reasoning_output_tokens", labelKey: "dashboard.projects.detail.comp_reasoning", color: "#fb7185" },
];

const MAX_TREND_BARS = 60;

// Fill calendar gaps so the trend reads as real cadence, not a compressed
// list of active days. Capped to the most recent MAX_TREND_BARS days, and
// never past "today" — a month range ends on the 31st, but rendering future
// days as zero bars would read as inactivity that hasn't happened yet.
function fillDailySeries(daily, from, to, todayKey) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const byDay = new Map(daily.map((d) => [d.day, d]));
  let start = from || daily[0].day;
  let end = to || daily[daily.length - 1].day;
  if (start > end) [start, end] = [end, start];
  if (todayKey && end > todayKey) end = todayKey;
  const lastDataDay = daily[daily.length - 1].day;
  if (end < lastDataDay) end = lastDataDay;
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(endDate.getTime())) return daily;
  const spanDays = Math.round((endDate.getTime() - cursor.getTime()) / 86400000) + 1;
  if (spanDays > MAX_TREND_BARS) {
    cursor.setUTCDate(cursor.getUTCDate() + (spanDays - MAX_TREND_BARS));
  }
  const out = [];
  while (cursor.getTime() <= endDate.getTime() && out.length < MAX_TREND_BARS) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) || { day: key, total_tokens: 0, billable_total_tokens: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  const pct = ratio * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

// Zoom-modal stat vocabulary: micro mono label over a heavy mono figure.
function StatCell({ label, value, title }) {
  return (
    <div className="flex flex-col gap-1.5 group min-w-0">
      <span className="text-[9px] font-bold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span
        className="text-xl font-black font-mono text-zinc-900 dark:text-zinc-50 tracking-tight leading-none tabular-nums truncate transition-transform duration-200 group-hover:-translate-y-[1px]"
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

// Host brand mark instead of a bare hostname string; the full host stays
// reachable via the title tooltip. Brand marks come from the ProviderIcon
// registry; unknown self-hosted forges get a neutral git glyph rather than
// a wrong brand.
function HostIcon({ host }) {
  if (!host) return null;
  let icon;
  const forge = forgeKindFromHost(host);
  if (forge === "github" || forge === "gitlab") {
    icon = <ProviderIcon provider={forge} size={12} className="fill-current" />;
  } else {
    icon = <GitBranch size={12} />;
  }
  return (
    <span title={host} aria-label={host} className="inline-flex flex-shrink-0 items-center">
      {icon}
    </span>
  );
}

function SectionLabel({ children }) {
  return (
    <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500 select-none">
      {children}
    </span>
  );
}

export function ProjectDetailModal({ entry, query = {}, onClose }) {
  const [isClosing, setIsClosing] = React.useState(false);
  const projectKey = typeof entry?.project_key === "string" ? entry.project_key : "";
  const { owner, repo } = splitProjectKey(projectKey);
  const projectRef = typeof entry?.project_ref === "string" ? entry.project_ref : "";
  const host = projectRefHost(projectRef);

  const { data, loading, error } = useProjectUsageDetail({
    projectKey,
    from: query.from,
    to: query.to,
    timeZone: query.timeZone,
    tzOffsetMinutes: query.tzOffsetMinutes,
  });

  const handleClose = React.useCallback(() => setIsClosing(true), []);
  const handleAnimationEnd = (e) => {
    if (e.target === e.currentTarget && isClosing) onClose();
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const tokenFormatOptions = {
    thousandSuffix: copy("shared.unit.thousand_abbrev"),
    millionSuffix: copy("shared.unit.million_abbrev"),
    billionSuffix: copy("shared.unit.billion_abbrev"),
    decimals: 1,
  };
  const compact = (value) => formatCompactNumber(value, tokenFormatOptions);

  const totals = data?.totals || null;
  const billableTotal = toFiniteNumber(totals?.billable_total_tokens) ?? 0;
  const daysActive = Number(data?.days_active || 0);
  const inputTokens = toFiniteNumber(totals?.input_tokens) ?? 0;
  const cachedTokens = toFiniteNumber(totals?.cached_input_tokens) ?? 0;
  const cacheHitRatio =
    inputTokens + cachedTokens > 0 ? cachedTokens / (inputTokens + cachedTokens) : null;
  const rangeTotal = toFiniteNumber(data?.range_total_tokens) ?? 0;
  const totalTokens = toFiniteNumber(totals?.total_tokens) ?? 0;
  const shareRatio = rangeTotal > 0 ? totalTokens / rangeTotal : null;

  const daily = React.useMemo(
    () =>
      fillDailySeries(
        data?.daily,
        data?.from,
        data?.to,
        getLocalDayKey({ timeZone: query.timeZone, offsetMinutes: query.tzOffsetMinutes }),
      ),
    [data, query.timeZone, query.tzOffsetMinutes],
  );
  const compositionTotal = COMPOSITION_SEGMENTS.reduce(
    (sum, seg) => sum + (toFiniteNumber(totals?.[seg.key]) ?? 0),
    0,
  );

  const sources = Array.isArray(data?.sources) ? data.sources : [];

  const hasData = !loading && !error && totals && totalTokens > 0;

  // Render inline (NOT createPortal to document.body) — see
  // TrendMonitorZoomModal: body-portaled overlays don't present on-screen in
  // the Windows WebView2 host's transparent composition.
  return (
    <div
      onAnimationEnd={handleAnimationEnd}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 backdrop-blur-md bg-black/15 dark:bg-black/40",
        isClosing ? "animate-tt-fade-out" : "animate-tt-fade-in",
      )}
    >
      {/* animate-tt-* / tt-* keyframes live in styles.css (shared modal motion) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={projectKey}
        className={cn(
          "relative w-full max-w-4xl max-h-[88vh] backdrop-blur-2xl bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-white/10 shadow-2xl rounded-2xl flex flex-col md:flex-row overflow-hidden",
          isClosing ? "animate-tt-modal-exit" : "animate-tt-modal",
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label={copy("dashboard.projects.detail.close_aria")}
          className="absolute top-4 right-4 z-50 p-2 rounded-full border border-oai-gray-200/60 dark:border-oai-gray-800/60 bg-white/50 dark:bg-oai-gray-900/50 text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:rotate-90 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60 transition-all duration-300"
        >
          <X size={16} />
        </button>

        {/* Left: identity + aggregate stats — terminal-native panel language */}
        <div className="w-full md:w-[300px] shrink-0 border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-5 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">
          <div className="select-none">
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: ACCENT }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: ACCENT }} />
              </span>
              <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
                {copy("dashboard.projects.detail.badge")}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 min-w-0">
              <ProjectAvatar
                githubOwner={githubOwnerFor(projectRef, owner)}
                letter={(repo?.[0] || projectKey?.[0] || "?").toUpperCase()}
                size="w-10 h-10"
              />
              <div className="min-w-0">
                {owner ? (
                  <p className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 truncate leading-tight">
                    {owner}/
                  </p>
                ) : null}
                <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-tight truncate">
                  {repo || projectKey || "—"}
                </h4>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 leading-relaxed">
              <HostIcon host={host} />
              {host && data?.from && data?.to ? <span>·</span> : null}
              {data?.from && data?.to ? (
                <span className="tabular-nums">{data.from} – {data.to}</span>
              ) : null}
            </div>
          </div>

          {hasData ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-t border-zinc-200/50 dark:border-zinc-800/50 pt-5 select-none">
              <StatCell
                label={copy("dashboard.projects.detail.stat_total")}
                value={compact(billableTotal)}
                title={toDisplayNumber(billableTotal)}
              />
              <StatCell
                label={copy("dashboard.projects.detail.stat_share")}
                value={shareRatio == null ? "—" : formatPercent(shareRatio)}
              />
              <StatCell
                label={copy("dashboard.projects.detail.stat_cache_hit")}
                value={cacheHitRatio == null ? "—" : formatPercent(cacheHitRatio)}
              />
              <StatCell
                label={copy("dashboard.projects.detail.stat_conversations")}
                value={toDisplayNumber(totals.conversation_count)}
              />
              <StatCell
                label={copy("dashboard.projects.detail.stat_active_days")}
                value={toDisplayNumber(daysActive)}
              />
              <StatCell
                label={copy("dashboard.projects.detail.stat_avg_day")}
                value={daysActive > 0 ? compact(Math.round(billableTotal / daysActive)) : "—"}
              />
            </div>
          ) : null}
        </div>

        {/* Right: charts. Hairline-divided sections (same tone as the
            left/right panel seam) give the column real structure — the
            micro section labels alone were too weak to separate blocks. */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {loading && (
            <div className="space-y-4 p-5 md:p-6">
              <div className="h-32 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
              <div className="h-16 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
              <div className="h-24 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
            </div>
          )}

          {!loading && error && (
            <p className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 p-5 md:p-6">
              {copy("dashboard.projects.detail.error")}
            </p>
          )}

          {!loading && !error && !hasData && (
            <p className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 p-5 md:p-6">
              {copy("dashboard.projects.detail.empty_range")}
            </p>
          )}

          {hasData && (
            <div className="divide-y divide-zinc-200/50 dark:divide-zinc-800/40">
              {/* Daily trend — the real TrendMonitor chart (embedded), so the
                  stacked per-source bars and hover breakdown tooltip behave
                  exactly like the dashboard's Usage Trend card. */}
              {daily.length > 1 && (
                <section className="px-5 py-5 md:px-6 first:md:pt-6">
                  <SectionLabel>{copy("dashboard.projects.detail.section_trend")}</SectionLabel>
                  <div className="mt-3">
                    <TrendMonitor
                      embedded
                      rows={daily}
                      from={daily[0]?.day}
                      to={daily[daily.length - 1]?.day}
                      period="month"
                      showTimeZoneLabel={false}
                      chartHeightClass="h-36"
                    />
                  </div>
                </section>
              )}

              {/* Token composition */}
              {compositionTotal > 0 && (
                <section className="px-5 py-5 md:px-6 first:md:pt-6">
                  <SectionLabel>
                    {copy("dashboard.projects.detail.section_composition")}
                  </SectionLabel>
                  <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full">
                    {COMPOSITION_SEGMENTS.map((seg) => {
                      const value = toFiniteNumber(totals[seg.key]) ?? 0;
                      if (value <= 0) return null;
                      return (
                        <div
                          key={seg.key}
                          style={{
                            width: `${(value / compositionTotal) * 100}%`,
                            backgroundColor: seg.color,
                            minWidth: "2px",
                          }}
                        />
                      );
                    })}
                  </div>
                  {/* Single compact legend row — visually distinct from the
                      taller BY SOURCE rows below so the two lists don't blur
                      into one another. */}
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                    {COMPOSITION_SEGMENTS.map((seg) => {
                      const value = toFiniteNumber(totals[seg.key]) ?? 0;
                      return (
                        <div key={seg.key} className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: seg.color }}
                          />
                          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {copy(seg.labelKey)}
                          </span>
                          <span
                            className="text-[11px] font-bold font-mono text-zinc-900 dark:text-zinc-50 tabular-nums"
                            title={toDisplayNumber(value)}
                          >
                            {compact(value)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Source breakdown — BY DEVICE-style rows: name line + a
                  full-width bar tinted with the provider's chart color, so
                  each row ties back to its segments in the daily chart. */}
              {sources.length > 0 && (
                <section className="px-5 py-5 md:px-6 first:md:pt-6">
                  <SectionLabel>{copy("dashboard.projects.detail.section_sources")}</SectionLabel>
                  <div className="mt-3 space-y-3.5">
                    {sources.map((src) => {
                      const value = Number(src.total_tokens || 0);
                      const srcShare = totalTokens > 0 ? value / totalTokens : 0;
                      const sharePct = srcShare * 100;
                      const convCount = Number(src.conversation_count || 0);
                      const color = getModelColor(src.source || "unknown");
                      return (
                        <div key={src.source}>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <ProviderIcon
                              provider={src.source}
                              size={13}
                              className="flex-shrink-0"
                            />
                            <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50 truncate">
                              {src.source}
                            </span>
                            <span className="hidden text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums whitespace-nowrap sm:inline">
                              {copy("dashboard.projects.detail.source_days", {
                                n: Number(src.days_active || 0),
                              })}
                              {/* Some providers attribute tokens per project but not
                                  conversations; 0 there means "unknown", not zero. */}
                              {convCount > 0 ? (
                                <>
                                  {" · "}
                                  {copy("dashboard.projects.detail.source_conv", { n: convCount })}
                                </>
                              ) : null}
                            </span>
                            <span
                              className="ml-auto text-[12px] font-bold font-mono text-zinc-900 dark:text-zinc-50 tabular-nums"
                              title={toDisplayNumber(value)}
                            >
                              {compact(value)}
                            </span>
                            <span className="w-9 text-right text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums">
                              {formatPercent(srcShare)}
                            </span>
                          </div>
                          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/60">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(sharePct, value > 0 ? 1 : 0))}%`,
                                minWidth: value > 0 ? "3px" : 0,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
