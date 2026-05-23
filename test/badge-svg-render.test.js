/**
 * Pure renderer test for the README badge SVG endpoint.
 *
 * The InsForge Edge function in dashboard/edge-patches/tokentracker-badge-svg.ts
 * runs under Deno, but its SVG rendering logic is pure — we mirror it here as
 * a CommonJS port so we can unit-test the output shape, sizing math, and
 * sanitization without needing a Deno runtime.
 *
 * Keep this file in sync with the Deno endpoint when changing renderBadgeSvg
 * or compactNumber/formatCost. The Deno copy is the source of truth.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compactNumber(n) {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, "") + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K";
  return String(Math.round(n));
}

function formatCost(n) {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 100) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}

function textWidth(s) {
  return Math.max(s.length * 6.2, 0);
}

const BRAND_GREEN = "#059669";
const LABEL_BG = "#555";

function renderBadgeSvg({ label, value, style, color }) {
  const padX = 6;
  const labelWidth = Math.ceil(textWidth(label) + padX * 2);
  const valueWidth = Math.ceil(textWidth(value) + padX * 2);
  const totalWidth = labelWidth + valueWidth;
  const height = 20;
  const rx = style === "flat-square" ? 0 : 3;

  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const labelTextX = labelWidth / 2;
  const valueTextX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${safeLabel}: ${safeValue}">
  <title>${safeLabel}: ${safeValue}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="${height}" rx="${rx}" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${height}" fill="${LABEL_BG}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelTextX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelWidth * 10 - padX * 20}">${safeLabel}</text>
    <text x="${labelTextX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelWidth * 10 - padX * 20}">${safeLabel}</text>
    <text aria-hidden="true" x="${valueTextX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${valueWidth * 10 - padX * 20}">${safeValue}</text>
    <text x="${valueTextX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${valueWidth * 10 - padX * 20}">${safeValue}</text>
  </g>
</svg>`;
}

test("compactNumber covers magnitudes", () => {
  assert.equal(compactNumber(0), "0");
  assert.equal(compactNumber(999), "999");
  assert.equal(compactNumber(1500), "1.5K");
  assert.equal(compactNumber(2_500_000), "2.5M");
  assert.equal(compactNumber(9_422_678_431), "9.42B");
  assert.equal(compactNumber(1.5e12), "1.5T");
});

test("formatCost rounds large vs small", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.42), "$0.42");
  assert.equal(formatCost(99.5), "$99.50");
  assert.equal(formatCost(150), "$150");
  assert.equal(formatCost(9414.84), "$9,415");
});

test("renderBadgeSvg produces well-formed SVG with brand color", () => {
  const svg = renderBadgeSvg({
    label: "tokens",
    value: "9.42B tokens",
    style: "flat",
    color: BRAND_GREEN,
  });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="tokens: 9\.42B tokens"/);
  assert.match(svg, new RegExp(BRAND_GREEN));
  // width must be deterministic given the label/value
  const widthMatch = svg.match(/width="(\d+)"/);
  assert.ok(widthMatch);
  const w = Number(widthMatch[1]);
  // "tokens" -> 6 chars * 6.2 + 12 padding = ~50, "9.42B tokens" -> 12 * 6.2 + 12 = ~87
  assert.ok(w > 100 && w < 200, `unexpected width ${w}`);
});

test("renderBadgeSvg escapes XML in label and value", () => {
  const svg = renderBadgeSvg({
    label: "<script>",
    value: 'a & b "c"',
    style: "flat",
    color: BRAND_GREEN,
  });
  assert.ok(!svg.includes("<script>"), "raw <script> must not leak into output");
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /&quot;c&quot;/);
});

test("flat-square sets rx=0; flat sets rx=3", () => {
  const flat = renderBadgeSvg({ label: "x", value: "y", style: "flat", color: BRAND_GREEN });
  const square = renderBadgeSvg({ label: "x", value: "y", style: "flat-square", color: BRAND_GREEN });
  assert.match(flat, /rx="3"/);
  assert.match(square, /rx="0"/);
});

test("UUID regex used in endpoint validates real id", () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok(re.test("0652839f-d19f-4f67-af85-6b7675875443"));
  assert.ok(!re.test("not-a-uuid"));
  assert.ok(!re.test("0652839f-d19f-4f67-af85-6b7675875443; DROP TABLE")); // SQL probe must be rejected
});
