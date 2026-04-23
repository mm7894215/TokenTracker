import React, { useEffect, useState } from "react";
import { ArrowUpRight, Download, Monitor } from "lucide-react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { isNativeEmbed, nativeAction } from "../lib/native-bridge.js";
import { FadeIn, StaggerContainer, StaggerItem } from "../ui/foundation/FadeIn.jsx";

/* ---------- SVG widget illustrations ----------
 * Hand-drawn previews of the real macOS widgets. Pure SVG so they stay
 * crisp at any scale and don't require shipping PNGs.
 *
 * Hardcoded strings ("TODAY", "203.2M", "claude-opus-4-6", etc.)
 * intentionally bypass copy.csv — they mirror the literal Swift string
 * constants in TokenTrackerWidget/Widgets/*.swift which ship English-only
 * in the native app. Keeping them inline makes the preview read as a
 * faithful screenshot.
 */

const WIDGET_W = 264;
const WIDGET_H = 124;
const ROUNDED_FONT = "ui-rounded, -apple-system, system-ui";

// Model accent palette — mirrors WidgetTheme.modelDot in
// TokenTrackerBar/TokenTrackerWidget/Views/WidgetTheme.swift
const MODEL_COLORS = ["#5A8CF2", "#9973E6", "#4DB8A6", "#E68C59"];

// Source accent palette — mirrors WidgetTheme.sourceColor (SwiftUI system
// colors, approximated in hex to match rendered appearance)
const SOURCE_COLORS = {
  claude: "#C77DFF", // SwiftUI .purple
  codex: "#34C759",  // SwiftUI .green
  cursor: "#FFCC00", // SwiftUI .yellow
  gemini: "#0A84FF", // SwiftUI .blue
};

// Limit bar fill — mirrors WidgetTheme.limitBarColor
function limitBarFill(fraction) {
  if (fraction >= 0.9) return "#E64D4D"; // red
  if (fraction >= 0.7) return "#D9A633"; // amber
  return "#33B866";                      // green
}

/**
 * PreviewShell — renders a widget tile at the real macOS systemMedium
 * aspect ratio (~2.13:1). `size="lg"` is the hero (up to 560px wide),
 * `size="sm"` is a secondary catalog tile (up to 264px wide). Both scale
 * down responsively on narrow viewports using CSS aspect-ratio.
 *
 * `rounded-[22/32px]` is an intentional deviation from the design system's
 * token radii: it mimics the macOS continuous-corner widget radius so the
 * preview reads as an Apple widget rather than a generic card.
 */
function PreviewShell({ size = "sm", children }) {
  const isHero = size === "lg";
  const maxWidth = isHero ? 560 : 264;
  const radius = isHero ? 32 : 22;
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-xl bg-oai-gray-100 dark:bg-oai-gray-950/60",
        isHero ? "py-10 sm:py-14 px-6" : "py-6 px-4",
      )}
    >
      <div
        className="overflow-hidden bg-white dark:bg-oai-gray-800 shadow-oai-md dark:shadow-[0_2px_4px_rgba(0,0,0,0.4),0_8px_24px_rgba(0,0,0,0.5)]"
        style={{
          width: "100%",
          maxWidth,
          aspectRatio: `${WIDGET_W} / ${WIDGET_H}`,
          borderRadius: radius,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SummaryWidgetPreview({ size = "sm" }) {
  // Sparkline curve — extended flat at both ends so it spans the full tile
  // width (x=0 → x=264) instead of leaving visible gaps at the widget edges.
  const sparklinePath =
    "M0,104 L14,104 C26,98 34,100 44,96 S58,88 68,92 80,100 90,94 102,80 112,82 126,92 136,88 150,74 162,76 178,88 188,86 204,72 216,74 236,84 250,80 L264,80";
  // Closed area: follow the curve then drop to the baseline and back.
  const areaPath = `${sparklinePath} L264,124 L0,124 Z`;
  const gradientId = `sparkArea-${size}`;
  return (
    <PreviewShell size={size}>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0A84FF" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* TODAY column */}
        <text x="14" y="20" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="700" letterSpacing="0.6">TODAY</text>
        <text x="14" y="46" className="fill-oai-black dark:fill-white" fontSize="22" fontWeight="700" fontFamily={ROUNDED_FONT}>203.2M</text>
        <text x="14" y="60" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>$129.56 ±0%</text>
        {/* 7 DAYS column */}
        <text x="134" y="20" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="700" letterSpacing="0.6">7 DAYS</text>
        <text x="134" y="46" className="fill-oai-black dark:fill-white" fontSize="22" fontWeight="700" fontFamily={ROUNDED_FONT}>880.9M</text>
        <text x="134" y="60" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>$673.61</text>
        {/* Area fill under the curve */}
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        {/* Sparkline stroke on top */}
        <path d={sparklinePath} fill="none" stroke="#0A84FF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </PreviewShell>
  );
}

// Deterministic heatmap cells — 26 weeks × 7 days, matching Swift
// HeatmapWidget.weeks for systemMedium. Uses a sin-hash (GLSL classic)
// because modular PRNG on small seed ranges produces a visible "letter"
// pattern. Computed once at module load.
const HEATMAP_CELLS = (() => {
  const weeks = 26;
  const days = 7;
  const cells = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < days; d++) {
      const n = Math.sin((w + 1) * 12.9898 + (d + 1) * 78.233 + 17) * 43758.5453;
      const v = Math.floor(Math.abs(n - Math.floor(n)) * 100);
      cells.push({ w, d, v });
    }
  }
  return cells;
})();

// Mirrors WidgetTheme.heatmapLevels — gray base + four steps of accent blue.
// Empty cells snap to oai-gray-200 / -800 (design tokens); blue stays as
// the macOS system accent, matching SwiftUI's Color.accentColor.
function heatmapFill(v, dark) {
  if (v < 18) return dark ? "#262626" /* oai-gray-800 */ : "#e5e5e5" /* oai-gray-200 */;
  if (v < 38) return "rgba(10, 132, 255, 0.28)";
  if (v < 58) return "rgba(10, 132, 255, 0.50)";
  if (v < 80) return "rgba(10, 132, 255, 0.75)";
  return "#0A84FF";
}

function HeatmapWidgetPreview() {
  // 264×124 tile: cellW 7.5, cellH 8, gap 1.2
  //   grid width  = 26*7.5 + 25*1.2 = 225   → left margin (264-225)/2 = 19.5
  //   grid height = 7*8   + 6*1.2  = 63.2  → top margin 10
  //   footer baseline at y=102 → ~22px clear above the bottom edge
  const cellW = 7.5;
  const cellH = 8;
  const gap = 1.2;
  const gridX = 19.5;
  const gridY = 10;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        <g transform={`translate(${gridX}, ${gridY})`} className="hidden dark:inline">
          {HEATMAP_CELLS.map((c) => (
            <rect key={`d-${c.w}-${c.d}`} x={c.w * (cellW + gap)} y={c.d * (cellH + gap)} width={cellW} height={cellH} rx="1.3" fill={heatmapFill(c.v, true)} />
          ))}
        </g>
        <g transform={`translate(${gridX}, ${gridY})`} className="dark:hidden">
          {HEATMAP_CELLS.map((c) => (
            <rect key={`l-${c.w}-${c.d}`} x={c.w * (cellW + gap)} y={c.d * (cellH + gap)} width={cellW} height={cellH} rx="1.3" fill={heatmapFill(c.v, false)} />
          ))}
        </g>
        <text x={gridX} y="102" className="fill-oai-black dark:fill-white" fontSize="10" fontWeight="700" fontFamily={ROUNDED_FONT}>10.3B</text>
        <text x={gridX + 30} y="102" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="9" fontWeight="500">tokens · 202 active days</text>
      </svg>
    </PreviewShell>
  );
}

function TopModelsWidgetPreview() {
  // Four rows mirroring ModelBar in TopModelsWidget.swift. Bar fill matches
  // the dot color (not a neutral track) — this is intentional per Swift.
  const models = [
    { name: "claude-opus-4-6",            value: "586.4M", pct: 59 },
    { name: "claude-sonnet-4-5-20250929", value: "218.7M", pct: 22 },
    { name: "gpt-5.4",                    value: "80.6M",  pct: 8 },
    { name: "composer-2-fast",            value: "52.1M",  pct: 5 },
  ];
  const rowGap = 22;
  // Vertically centered: content spans ~78px in a 124px tile.
  const rowStart = 28;
  const trackX = 14;
  const trackW = 236;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        {models.map((m, i) => {
          const y = rowStart + i * rowGap;
          const color = MODEL_COLORS[i % MODEL_COLORS.length];
          return (
            <g key={m.name}>
              <circle cx="18" cy={y - 3} r="2.5" fill={color} />
              <text x="26" y={y} className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="500">{m.name}</text>
              <text x="218" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="9" fontWeight="600" fontFamily={ROUNDED_FONT}>{m.value}</text>
              <text x="250" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="600" fontFamily={ROUNDED_FONT}>{m.pct}%</text>
              <rect x={trackX} y={y + 4} width={trackW} height="2.8" rx="1.4" className="fill-oai-gray-200 dark:fill-oai-gray-700" />
              <rect x={trackX} y={y + 4} width={Math.max(trackW * (m.pct / 100), 4)} height="2.8" rx="1.4" fill={color} />
            </g>
          );
        })}
      </svg>
    </PreviewShell>
  );
}

function UsageLimitsWidgetPreview() {
  // Four rows mirroring LimitRow in UsageLimitsWidget.swift. Bullet color
  // follows the provider source; bar fill follows limitBarColor(fraction).
  const rows = [
    { label: "Claude · 7d",    source: "claude", reset: "in 1d",     pct: 61 },
    { label: "Claude · 5h",    source: "claude", reset: "in 4h 28m", pct: 4 },
    { label: "Cursor",         source: "cursor", reset: "in 25d",    pct: 51 },
    { label: "Codex · weekly", source: "codex",  reset: "in 1d",     pct: 32 },
  ];
  const rowGap = 22;
  const rowStart = 28;
  const trackX = 14;
  const trackW = 236;
  return (
    <PreviewShell>
      <svg viewBox="0 0 264 124" className="h-full w-full" aria-hidden="true">
        {rows.map((r, i) => {
          const y = rowStart + i * rowGap;
          const dot = SOURCE_COLORS[r.source];
          const fill = limitBarFill(r.pct / 100);
          return (
            <g key={r.label}>
              <circle cx="18" cy={y - 3} r="2.5" fill={dot} />
              <text x="26" y={y} className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="500">{r.label}</text>
              <text x="218" y={y} textAnchor="end" className="fill-oai-gray-500 dark:fill-oai-gray-400" fontSize="8" fontWeight="500" fontFamily={ROUNDED_FONT}>{r.reset}</text>
              <text x="250" y={y} textAnchor="end" className="fill-oai-black dark:fill-white" fontSize="9" fontWeight="700" fontFamily={ROUNDED_FONT}>{r.pct}%</text>
              <rect x={trackX} y={y + 4} width={trackW} height="2.8" rx="1.4" className="fill-oai-gray-200 dark:fill-oai-gray-700" />
              <rect x={trackX} y={y + 4} width={Math.max(trackW * (r.pct / 100), 4)} height="2.8" rx="1.4" fill={fill} />
            </g>
          );
        })}
      </svg>
    </PreviewShell>
  );
}

/* ---------- Header CTA — adaptive by platform ----------
 * native  → inside the menu bar app's WKWebView (bridge currently available)
 * mac-web → browser on macOS (can download the native app)
 * other   → non-macOS browser (widgets unsupported)
 *
 * NOTE: we use `isNativeEmbed()` here (checks `window.webkit.messageHandlers
 * .nativeBridge` directly) instead of `isNativeApp()` (which reads a sticky
 * localStorage flag). The sticky flag persists after the native app launched
 * the dashboard once, so later opening `localhost:5173` in a regular browser
 * would incorrectly report native mode — clicks would then fire a bridge
 * message into the void. isNativeEmbed is the honest "right now" test.
 */
function useClientPlatform() {
  const [platform, setPlatform] = useState("loading");
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isNativeEmbed()) {
      setPlatform("native");
      return;
    }
    const ua = (navigator.userAgent || "").toLowerCase();
    const isMac = /mac/.test(ua) && !/iphone|ipad/.test(ua);
    setPlatform(isMac ? "mac-web" : "other");
  }, []);
  return platform;
}

function HeaderCta() {
  const platform = useClientPlatform();

  // Reserve space so the layout doesn't jump once detection resolves.
  if (platform === "loading") {
    return <div className="h-10 w-40" aria-hidden="true" />;
  }

  if (platform === "native") {
    return (
      <button
        type="button"
        onClick={() => nativeAction("openWidgetGallery")}
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-oai-black px-4 text-sm font-medium text-white transition-colors hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
      >
        {copy("widgets.cta.open_gallery")}
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  if (platform === "mac-web") {
    return (
      <a
        href="https://github.com/mm7894215/TokenTracker/releases/latest"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-oai-black px-4 text-sm font-medium text-white no-underline transition-colors hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:bg-white dark:text-oai-black dark:hover:bg-oai-gray-200"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {copy("widgets.cta.download")}
      </a>
    );
  }

  // Non-macOS — widgets aren't available, tell the user gently.
  return (
    <span className="inline-flex h-10 items-center gap-2 rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-4 text-sm font-medium text-oai-gray-500 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-400">
      <Monitor className="h-4 w-4" aria-hidden="true" />
      {copy("widgets.cta.macos_only")}
    </span>
  );
}

/* ---------- Secondary catalog data ---------- */

const SECONDARY_WIDGETS = [
  { id: "heatmap",   Preview: HeatmapWidgetPreview,    nameKey: "widgets.heatmap.name",   descKey: "widgets.heatmap.description" },
  { id: "topModels", Preview: TopModelsWidgetPreview,  nameKey: "widgets.topModels.name", descKey: "widgets.topModels.description" },
  { id: "limits",    Preview: UsageLimitsWidgetPreview, nameKey: "widgets.limits.name",   descKey: "widgets.limits.description" },
];

/* ---------- Page ---------- */

export function WidgetsPage() {
  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          {/* Header — title + subtitle left, adaptive CTA right */}
          <FadeIn y={12}>
            <header className="mb-10 flex flex-col gap-6 sm:mb-14 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="mb-3 text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                  {copy("widgets.page.title")}
                </h1>
                <p className="max-w-xl text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">
                  {copy("widgets.page.subtitle")}
                </p>
              </div>
              <div className="shrink-0">
                <HeaderCta />
              </div>
            </header>
          </FadeIn>

          {/* Hero — Summary widget at 2× scale, with a single annotation
              compressing the old four-step tutorial into one line */}
          <FadeIn y={16} delay={0.08}>
            <section className="mb-14 sm:mb-16" aria-label={copy("widgets.hero.aria")}>
              <SummaryWidgetPreview size="lg" />
              <p className="mt-5 text-center text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {copy("widgets.hero.annotation")}
              </p>
            </section>
          </FadeIn>

          {/* Secondary catalog — three smaller tiles for the remaining widgets */}
          <section>
            <h2 className="mb-5 text-xs font-semibold uppercase tracking-wider text-oai-gray-500 dark:text-oai-gray-400">
              {copy("widgets.section.more")}
            </h2>
            <StaggerContainer staggerDelay={0.08} initialDelay={0.12}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-5">
                {SECONDARY_WIDGETS.map(({ id, Preview, nameKey, descKey }) => (
                  <StaggerItem key={id}>
                    <article className="rounded-xl border border-oai-gray-200 bg-white p-4 transition-colors duration-200 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:p-5">
                      <Preview />
                      <div className="mt-4">
                        <h3 className="text-[15px] font-semibold text-oai-black dark:text-white">
                          {copy(nameKey)}
                        </h3>
                        <p className="mt-1.5 text-sm leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                          {copy(descKey)}
                        </p>
                      </div>
                    </article>
                  </StaggerItem>
                ))}
              </div>
            </StaggerContainer>
          </section>
        </div>
      </main>
    </div>
  );
}
