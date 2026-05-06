import React from "react";
import { copy } from "../../../lib/copy";
import {
  formatTokens,
  formatCost,
  formatShortDate,
  formatIssueLabel,
  heroFontSize,
  buildShareHook,
} from "../build-share-card-data";
import { HeatmapStrip } from "../HeatmapStrip.jsx";

// Broadsheet — editorial magazine cover aesthetic.
// Ivory paper, warm black ink, single vermillion accent.
// Instrument Serif display + Inter Tight body. Asymmetric grid.

const PAPER = "oklch(0.97 0.01 85)";
const INK = "oklch(0.18 0.02 85)";
const INK_SOFT = "oklch(0.38 0.015 85)";
const RULE = "oklch(0.55 0.012 85)";
const VERMILLION = "oklch(0.55 0.22 25)";

const FONT_DISPLAY = '"Instrument Serif", "Times New Roman", Georgia, serif';
const FONT_BODY = '"Inter Tight", "Helvetica Neue", Arial, sans-serif';

// Editorial heatmap palette: warm paper tones stepping into vermillion.
const HEATMAP_PALETTE = [
  "oklch(0.93 0.013 80)",
  "oklch(0.87 0.04 55)",
  "oklch(0.78 0.09 45)",
  "oklch(0.67 0.16 35)",
  "oklch(0.55 0.22 25)",
];

export function BroadsheetCard({ data }) {
  const issueLabel = formatIssueLabel(data);
  const heroNumber = formatTokens(data.totalTokens);
  const costLabel = formatCost(data.totalCost);
  const startLabel = formatShortDate(data.startDate);
  const heroSize = heroFontSize(heroNumber, {
    baseSize: 188,
    baseChars: 9,
    shrinkPerChar: 14,
    minSize: 104,
  });
  const hookLine = buildShareHook(data);
  const hasHeatmap = Array.isArray(data.heatmapWeeks) && data.heatmapWeeks.length > 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: PAPER,
        color: INK,
        fontFamily: FONT_BODY,
        padding: "80px 88px 68px 88px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {/* Masthead — single line, compressed for thumbnail legibility */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
          paddingBottom: 14,
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: INK,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: VERMILLION,
            }}
          />
          The Token Tracker
        </div>
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: INK_SOFT,
            textAlign: "right",
          }}
        >
          {copy("share.card.broadsheet.issue")} № {issueLabel}
        </div>
      </header>

      {/* Byline */}
      <div
        style={{
          marginTop: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 24,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: INK_SOFT,
              marginBottom: 6,
            }}
          >
            {copy("share.card.broadsheet.by")}
          </div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 52,
              fontStyle: "italic",
              lineHeight: 1,
              color: INK,
              letterSpacing: "-0.01em",
            }}
          >
            {data.handle}
          </div>
        </div>
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: INK_SOFT,
            textAlign: "right",
            lineHeight: 1.6,
          }}
        >
          {copy("share.card.broadsheet.tracked_since")}
          <br />
          <span style={{ color: INK }}>{startLabel}</span>
        </div>
      </div>

      {/* Hero headline — left-aligned, dynamic size, hook below */}
      <div
        style={{
          marginTop: 40,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            fontSize: 13,
            letterSpacing: "0.3em",
            textTransform: "uppercase",
            color: VERMILLION,
            marginBottom: 10,
          }}
        >
          {copy("share.card.broadsheet.total_tokens")}
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: heroSize,
            fontWeight: 400,
            lineHeight: 0.86,
            letterSpacing: "-0.032em",
            color: INK,
            fontFeatureSettings: '"lnum" 1, "tnum" 1',
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {heroNumber}
        </div>
        {/* Verbal hook — the quotable one-liner for social share */}
        <div
          style={{
            marginTop: 14,
            fontFamily: FONT_DISPLAY,
            fontStyle: "italic",
            fontSize: 34,
            lineHeight: 1.15,
            color: INK,
            letterSpacing: "-0.005em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          “{hookLine}”
        </div>
        <div
          style={{
            marginTop: 14,
            height: 1,
            background: VERMILLION,
            width: "100%",
          }}
        />
        <div
          style={{
            marginTop: 10,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: INK_SOFT,
          }}
        >
          <span>{copy("share.card.broadsheet.estimated_spend")} · {costLabel}</span>
          <span>{copy("share.card.broadsheet.billable_days", { days: data.activeDays })}</span>
        </div>
      </div>

      {/* Heatmap — "The Year in Print" */}
      {hasHeatmap ? (
        <section style={{ marginTop: 40 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: 12,
                letterSpacing: "0.3em",
                textTransform: "uppercase",
                color: INK,
                fontWeight: 600,
              }}
            >
              {copy("share.card.broadsheet.heatmap_title")}
            </div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: INK_SOFT,
              }}
            >
              {copy("share.card.broadsheet.heatmap_days_on_record", {
                active: data.heatmapActiveDays,
                total: data.heatmapTotalDays,
              })}
            </div>
          </div>
          <HeatmapStrip
            weeks={data.heatmapWeeks}
            palette={HEATMAP_PALETTE}
            width={1024}
            gap={3}
            radius={2}
          />
        </section>
      ) : null}

      {/* Top Models */}
      <section style={{ marginTop: 30, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            borderBottom: `1px solid ${INK}`,
            paddingBottom: 10,
            marginBottom: 6,
          }}
        >
          <div
            style={{
              fontSize: 12,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              color: INK,
              fontWeight: 600,
            }}
          >
            {copy("share.card.broadsheet.roster_title")}
          </div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: INK_SOFT,
            }}
          >
            {copy("share.card.broadsheet.roster_subtitle")}
          </div>
        </div>

        {data.topModels.length === 0 ? (
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontStyle: "italic",
              fontSize: 26,
              color: INK_SOFT,
              paddingTop: 14,
            }}
          >
            {copy("share.card.broadsheet.empty")}
          </div>
        ) : (
          data.topModels.map((model, index) => (
            <div
              key={model.id || model.name}
              style={{
                display: "grid",
                gridTemplateColumns: "52px 1fr auto 68px",
                alignItems: "baseline",
                gap: 16,
                padding: "13px 0",
                borderBottom: `1px solid ${RULE}`,
              }}
            >
              <div
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 34,
                  fontStyle: "italic",
                  color: VERMILLION,
                  lineHeight: 1,
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </div>
              <div
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 32,
                  color: INK,
                  lineHeight: 1.1,
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {model.name}
              </div>
              <div
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 28,
                  color: INK,
                  fontFeatureSettings: '"lnum" 1, "tnum" 1',
                  whiteSpace: "nowrap",
                }}
              >
                {formatTokens(model.tokens)}
              </div>
              <div
                style={{
                  fontSize: 13,
                  letterSpacing: "0.1em",
                  color: INK_SOFT,
                  textAlign: "right",
                  fontFeatureSettings: '"tnum" 1',
                }}
              >
                {model.percent}%
              </div>
            </div>
          ))
        )}
      </section>

      {/* Footer — rank/streak on left, CTA watermark on right */}
      <footer
        style={{
          marginTop: 18,
          paddingTop: 12,
          borderTop: `1px solid ${INK}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: INK,
        }}
        >
          <div style={{ display: "flex", gap: 28 }}>
          <span>
            {copy("share.card.broadsheet.global_rank")}{" "}
            <span style={{ color: VERMILLION }}>
              № {data.rank != null ? data.rank : "—"}
            </span>
          </span>
          <span>
            {copy("share.card.broadsheet.active_days")}{" "}
            <span style={{ color: VERMILLION }}>
              {copy("share.card.broadsheet.days_count", { days: data.activeDays })}
            </span>
          </span>
        </div>
        <div>
          {copy("share.card.broadsheet.track_yours")}{" "}
          <span style={{ color: VERMILLION }}>→ tokentracker.cc</span>
        </div>
      </footer>
    </div>
  );
}
