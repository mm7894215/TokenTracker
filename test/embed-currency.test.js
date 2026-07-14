/**
 * Mirror of dashboard/edge-patches/embed-currency.ts for node:test.
 * Keep in sync when changing embed currency helpers.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const EMBED_SUPPORTED_CURRENCY_CODES = ["USD", "EUR", "GBP", "CNY", "JPY", "HKD", "INR"];

const EMBED_CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CNY: "¥",
  JPY: "¥",
  HKD: "HK$",
  INR: "₹",
};

const EMBED_CURRENCY_DEFAULT_RATES = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CNY: 7.2,
  JPY: 155,
  HKD: 7.8,
  INR: 83.5,
};

function isValidRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeEmbedCurrency(value) {
  const upper = String(value || "USD")
    .trim()
    .toUpperCase();
  return EMBED_SUPPORTED_CURRENCY_CODES.includes(upper) ? upper : "USD";
}

function parseEmbedCurrency(searchParams) {
  const code = normalizeEmbedCurrency(searchParams.get("currency"));
  const symbol = EMBED_CURRENCY_SYMBOLS[code];
  const rateRaw = searchParams.get("rate");
  const parsedRate = rateRaw != null && rateRaw.trim() !== "" ? Number(rateRaw) : NaN;
  const rate = isValidRate(parsedRate) ? parsedRate : EMBED_CURRENCY_DEFAULT_RATES[code];
  return { code, symbol, rate };
}

function formatEmbedCost(usd, opts) {
  const { code, symbol, rate } = opts;
  if (!Number.isFinite(usd)) return `${symbol}0.00`;
  const converted = code === "USD" ? usd : usd * rate;
  if (converted >= 1000) return symbol + Math.round(converted).toLocaleString("en-US");
  if (converted >= 100) return symbol + converted.toFixed(0);
  return symbol + converted.toFixed(2);
}

test("parseEmbedCurrency defaults to USD", () => {
  const opts = parseEmbedCurrency(new URLSearchParams());
  assert.equal(opts.code, "USD");
  assert.equal(opts.symbol, "$");
  assert.equal(opts.rate, 1);
});

test("parseEmbedCurrency resolves INR with bundled rate", () => {
  const opts = parseEmbedCurrency(new URLSearchParams("currency=INR"));
  assert.equal(opts.code, "INR");
  assert.equal(opts.symbol, "₹");
  assert.equal(opts.rate, 83.5);
});

test("parseEmbedCurrency accepts custom rate override", () => {
  const opts = parseEmbedCurrency(new URLSearchParams("currency=INR&rate=90"));
  assert.equal(opts.rate, 90);
});

test("formatEmbedCost converts USD to INR", () => {
  const opts = parseEmbedCurrency(new URLSearchParams("currency=INR&rate=83.5"));
  assert.equal(formatEmbedCost(1, opts), "₹83.50");
  assert.equal(formatEmbedCost(0.5, opts), "₹41.75");
});

test("formatEmbedCost rounds large INR amounts", () => {
  const opts = parseEmbedCurrency(new URLSearchParams("currency=INR&rate=83.5"));
  assert.equal(formatEmbedCost(100, opts), "₹8,350");
});
