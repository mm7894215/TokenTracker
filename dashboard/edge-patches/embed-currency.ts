/**
 * Currency helpers for InsForge edge SVG endpoints (Deno).
 * Mirrors bundled defaults from dashboard/src/lib/currency.ts — keep in sync.
 */

export const EMBED_SUPPORTED_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "CNY",
  "JPY",
  "HKD",
  "INR",
] as const;

export type EmbedCurrencyCode = (typeof EMBED_SUPPORTED_CURRENCY_CODES)[number];

const EMBED_CURRENCY_SYMBOLS: Record<EmbedCurrencyCode, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CNY: "¥",
  JPY: "¥",
  HKD: "HK$",
  INR: "₹",
};

/** USD → currency multipliers (1 USD = rate units of target currency). */
export const EMBED_CURRENCY_DEFAULT_RATES: Record<EmbedCurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CNY: 7.2,
  JPY: 155,
  HKD: 7.8,
  INR: 83.5,
};

function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeEmbedCurrency(value: string | null | undefined): EmbedCurrencyCode {
  const upper = String(value || "USD")
    .trim()
    .toUpperCase();
  return (EMBED_SUPPORTED_CURRENCY_CODES as readonly string[]).includes(upper)
    ? (upper as EmbedCurrencyCode)
    : "USD";
}

export interface EmbedCurrencyOptions {
  code: EmbedCurrencyCode;
  symbol: string;
  rate: number;
}

export function parseEmbedCurrency(searchParams: URLSearchParams): EmbedCurrencyOptions {
  const code = normalizeEmbedCurrency(searchParams.get("currency"));
  const symbol = EMBED_CURRENCY_SYMBOLS[code];
  const rateRaw = searchParams.get("rate");
  const parsedRate = rateRaw != null && rateRaw.trim() !== "" ? Number(rateRaw) : NaN;
  const rate = isValidRate(parsedRate) ? parsedRate : EMBED_CURRENCY_DEFAULT_RATES[code];
  return { code, symbol, rate };
}

/**
 * Format a USD cost for embed/badge SVG output.
 */
export function formatEmbedCost(
  usd: number,
  opts: EmbedCurrencyOptions,
): string {
  const { code, symbol, rate } = opts;
  if (!Number.isFinite(usd)) return `${symbol}0.00`;
  const converted = code === "USD" ? usd : usd * rate;
  if (converted >= 1000) return symbol + Math.round(converted).toLocaleString("en-US");
  if (converted >= 100) return symbol + converted.toFixed(0);
  return symbol + converted.toFixed(2);
}
