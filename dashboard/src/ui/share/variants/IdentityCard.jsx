import React from "react";
import { copy } from "../../../lib/copy";
import { formatCost, formatIssueLabel, formatShortDate } from "../build-share-card-data";
import { normalizeVisibleStats } from "../share-card-options";
import {
  IDENTITY_CARD_SURFACE_HEIGHT,
  IDENTITY_CARD_SURFACE_WIDTH,
} from "../share-card-constants";
import { buildPalette } from "./identity-card-palettes";

const CARD_W = IDENTITY_CARD_SURFACE_WIDTH;
const CARD_H = IDENTITY_CARD_SURFACE_HEIGHT;
const FONT_DISPLAY = '"Instrument Serif", Georgia, serif';
const FONT_BODY = '"Inter Tight", "Helvetica Neue", sans-serif';
const FONT_MONO = '"IBM Plex Mono", monospace';

const WHITE = "hsl(0 0% 100%)";
const WHITE_SOFT = "hsl(0 0% 100% / 0.74)";
const WHITE_DIM = "hsl(0 0% 100% / 0.56)";
const DOT_COLS = 13;
const DOT_ROWS = 7;
const DOT_SIZE = 24;
const DOT_GAP = 8;
const BRAND_PANEL_WIDTH = 480;
const BRAND_PANEL_HEIGHT = 620;
const BRAND_FOOTER_HEIGHT = 118;
const STAT_LABEL_SIZE = 13;
const STAT_VALUE_SIZE = 26;
const STAT_VALUE_EMPHASIS_SIZE = 29;

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${trimFixed(n / 1e12, 2)}T`;
  if (abs >= 1e9) return `${trimFixed(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${trimFixed(n / 1e6, 2)}M`;
  if (abs >= 1e3) return `${trimFixed(n / 1e3, 1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function flattenHeatmap(weeks) {
  if (!Array.isArray(weeks)) return [];
  return weeks
    .flatMap((week) => (Array.isArray(week) ? week : []))
    .filter((cell) => cell?.day && !cell.future)
    .sort((a, b) => a.day.localeCompare(b.day));
}

function longestStreak(weeks) {
  const days = flattenHeatmap(weeks);
  let best = 0;
  let current = 0;
  for (const day of days) {
    current = day.level > 0 ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function displayDate(iso) {
  if (!iso) return "—";
  const day = iso.slice(0, 10);
  return day.includes("-") ? day.replace(/-/g, ".") : day;
}

function recentHeatmapWeeks(weeks) {
  const source = Array.isArray(weeks) ? weeks.slice(-DOT_COLS) : [];
  const padding = Math.max(0, DOT_COLS - source.length);
  const emptyWeeks = Array.from({ length: padding }, () => Array(DOT_ROWS).fill(null));
  return emptyWeeks.concat(source);
}

function DotField({ weeks, palette }) {
  const recentWeeks = recentHeatmapWeeks(weeks);
  const width = DOT_COLS * DOT_SIZE + (DOT_COLS - 1) * DOT_GAP;
  return (
    <div
      aria-hidden
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridTemplateRows: `repeat(${DOT_ROWS}, ${DOT_SIZE}px)`,
        gap: DOT_GAP,
        width,
        margin: "0 auto",
      }}
    >
      {recentWeeks.flatMap((week, weekIndex) =>
        Array.from({ length: DOT_ROWS }, (_, dayIndex) => {
          const cell = Array.isArray(week) ? week[dayIndex] : null;
          const level = cell && !cell.future ? Math.max(0, Math.min(4, cell.level || 0)) : 0;
          return (
            <div
              key={`${cell?.day || "pad"}-${weekIndex}-${dayIndex}`}
              style={{
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: 999,
                background: palette.dots[level],
                boxShadow: level > 2 ? palette.dotGlow : "none",
              }}
            />
          );
        }),
      )}
    </div>
  );
}

function IdentityFooter({ label, value, align = "left" }) {
  return (
    <div style={{ maxWidth: 196, textAlign: align }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.14em",
          color: WHITE_SOFT,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 21,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          lineHeight: 1.12,
          color: WHITE,
        }}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function BrandPanel({ data, issueLabel, palette }) {
  return (
    <section
      style={{
        position: "relative",
        width: BRAND_PANEL_WIDTH,
        height: BRAND_PANEL_HEIGHT,
        padding: "38px 34px 30px",
        borderRadius: 32,
        overflow: "hidden",
        background: palette.cardBg,
        color: WHITE,
        boxShadow: palette.cardShadow,
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: palette.halo }} />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
        }}
      >
        <DotField weeks={data.heatmapWeeks} palette={palette} />
        <div
          style={{
            marginTop: 34,
            fontFamily: FONT_DISPLAY,
            fontSize: 38,
            fontStyle: "italic",
            letterSpacing: "-0.02em",
          }}
        >
          {copy("share.card.identity.brand")}
        </div>
        <h1
          style={{
            margin: "8px 0 0",
            fontSize: 38,
            fontWeight: 500,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
          }}
        >
          {copy("share.card.identity.title")}
        </h1>
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 22,
            minHeight: BRAND_FOOTER_HEIGHT,
            paddingTop: 24,
            borderTop: `1px solid ${WHITE_DIM}`,
          }}
        >
          <IdentityFooter label={copy("share.card.identity.holder")} value={data.handle} />
          <IdentityFooter
            label={copy("share.card.identity.period")}
            value={issueLabel}
            align="right"
          />
        </div>
      </div>
    </section>
  );
}

function StatCard({ label, value, emphasis, palette }) {
  return (
    <div
      style={{
        minHeight: 92,
        borderRadius: 20,
        padding: "16px 18px 15px",
        background: emphasis ? palette.panel : palette.panelSoft,
        border: `1px solid ${palette.rule}`,
        boxShadow: palette.panelShadow,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <div
        style={{
          fontSize: STAT_LABEL_SIZE,
          fontWeight: 600,
          color: palette.label,
          letterSpacing: "-0.01em",
          lineHeight: 1.2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: emphasis ? STAT_VALUE_EMPHASIS_SIZE : STAT_VALUE_SIZE,
          fontWeight: emphasis ? 750 : 700,
          color: palette.ink,
          letterSpacing: "-0.025em",
          lineHeight: 1.08,
        }}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function rankLabel(period) {
  if (period === "day") return copy("share.card.identity.rank.day");
  if (period === "week") return copy("share.card.identity.rank.week");
  if (period === "month") return copy("share.card.identity.rank.month");
  return copy("share.card.identity.rank.total");
}

function topModelShare(top) {
  const pct = Number.parseFloat(top?.percent);
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : "—";
}

function averageValue(total, activeDays, formatter) {
  if (!Number.isFinite(total) || !Number.isFinite(activeDays) || activeDays <= 0) return "—";
  return formatter(total / activeDays);
}

function buildStats(data) {
  const top = data.topModels[0];
  const streak = longestStreak(data.heatmapWeeks);
  return [
    {
      id: "total_tokens",
      label: copy("share.card.identity.total_tokens"),
      value: compactNumber(data.totalTokens),
      emphasis: true,
    },
    {
      id: "estimated_cost",
      label: copy("share.card.identity.estimated_cost"),
      value: formatCost(data.totalCost),
      emphasis: true,
    },
    {
      id: "active_days",
      label: copy("share.card.identity.active_days"),
      value: copy("share.card.identity.days", { days: data.activeDays }),
      emphasis: false,
    },
    {
      id: "longest_streak",
      label: copy("share.card.identity.longest_streak"),
      value: copy("share.card.identity.days", { days: streak }),
      emphasis: false,
    },
    {
      id: "top_model",
      label: copy("share.card.identity.top_model"),
      value: top?.name || "—",
      emphasis: false,
    },
    {
      id: "top_model_share",
      label: copy("share.card.identity.top_model_share"),
      value: topModelShare(top),
      emphasis: false,
    },
    {
      id: "avg_daily_tokens",
      label: copy("share.card.identity.avg_daily_tokens"),
      value: averageValue(data.totalTokens, data.activeDays, compactNumber),
      emphasis: false,
    },
    {
      id: "avg_daily_cost",
      label: copy("share.card.identity.avg_daily_cost"),
      value: averageValue(data.totalCost, data.activeDays, formatCost),
      emphasis: false,
    },
    {
      id: "recorded_days",
      label: copy("share.card.identity.recorded_days"),
      value: `${data.heatmapActiveDays}/${data.heatmapTotalDays || "—"}`,
      emphasis: false,
    },
    {
      id: "tracked_since",
      label: copy("share.card.identity.tracked_since"),
      value: formatShortDate(data.startDate),
      emphasis: false,
    },
    {
      id: "period",
      label: copy("share.card.identity.period"),
      value: formatIssueLabel(data),
      emphasis: false,
    },
    {
      id: "rank",
      label: rankLabel(data.rankPeriod),
      value: data.rank ? `#${data.rank}` : "—",
      emphasis: false,
    },
  ];
}

function StatGrid({ data, palette }) {
  const visible = new Set(normalizeVisibleStats(data.visibleStats));
  const stats = buildStats(data).filter((item) => visible.has(item.id));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
      {stats.map((stat) => (
        <StatCard
          key={stat.id}
          label={stat.label}
          value={stat.value}
          emphasis={stat.emphasis}
          palette={palette}
        />
      ))}
    </div>
  );
}

export function IdentityCard({ data }) {
  const issueLabel = formatIssueLabel(data);
  const palette = buildPalette(data?.colorSeed || data?.capturedAt || data?.handle);
  return (
    <div
      style={{
        width: CARD_W,
        height: CARD_H,
        padding: 34,
        boxSizing: "border-box",
        background: palette.pageBg,
        color: palette.ink,
        fontFamily: FONT_BODY,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${BRAND_PANEL_WIDTH}px minmax(0, 1fr)`,
          gap: 28,
          height: "100%",
          alignItems: "stretch",
        }}
      >
        <BrandPanel data={data} issueLabel={issueLabel} palette={palette} />
        <main
          style={{
            padding: "10px 2px 10px 0",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 24,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 750,
                  letterSpacing: "-0.035em",
                  lineHeight: 1.04,
                }}
              >
                {copy("share.card.identity.panel_title")}
              </div>
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: palette.muted,
                textAlign: "right",
              }}
            >
              {displayDate(data.capturedAt)}
            </div>
          </header>
          <StatGrid data={data} palette={palette} />
        </main>
      </div>
    </div>
  );
}
