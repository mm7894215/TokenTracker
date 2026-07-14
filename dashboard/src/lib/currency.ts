import { safeGetItem, safeSetItem } from "./safe-browser";

export const CURRENCY_USD = "USD";
// Back-compat alias — some legacy callers still reference this constant by name.
export const CURRENCY_CNY = "CNY";

export const SUPPORTED_CURRENCY_CODES = ["USD", "EUR", "GBP", "CNY", "JPY", "HKD", "INR"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCY_CODES)[number];

interface CurrencyMeta {
  symbol: string;
  labelKey: string;
}

const CURRENCY_META: Record<CurrencyCode, CurrencyMeta> = {
  USD: { symbol: "$", labelKey: "settings.appearance.currency.opt.usd" },
  EUR: { symbol: "€", labelKey: "settings.appearance.currency.opt.eur" },
  GBP: { symbol: "£", labelKey: "settings.appearance.currency.opt.gbp" },
  CNY: { symbol: "¥", labelKey: "settings.appearance.currency.opt.cny" },
  JPY: { symbol: "¥", labelKey: "settings.appearance.currency.opt.jpy" },
  HKD: { symbol: "HK$", labelKey: "settings.appearance.currency.opt.hkd" },
  INR: { symbol: "₹", labelKey: "settings.appearance.currency.opt.inr" },
};

// Bundled defaults — last known good snapshot, used until the live fetch lands.
// Updated when bundled refresh ships; safe enough to render with offline.
export const DEFAULT_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CNY: 7.2,
  JPY: 155,
  HKD: 7.8,
  INR: 83.5,
};

export const CURRENCY_STORAGE_KEY = "tokentracker-currency";
export const EXCHANGE_RATES_STORAGE_KEY = "tokentracker-exchange-rates";
export const EXCHANGE_RATE_SOURCE_STORAGE_KEY = "tokentracker-exchange-rate-source";
export const EXCHANGE_RATE_FETCHED_AT_STORAGE_KEY = "tokentracker-exchange-rate-fetched-at";

export type RateSource = "default" | "fetched";

export interface ExchangeRatesState {
  rates: Record<string, number>;
  source: RateSource;
  fetchedAt: number | null;
}

export function isValidRate(value: any): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeCurrency(value: any): CurrencyCode {
  if (typeof value !== "string") return CURRENCY_USD;
  const upper = value.trim().toUpperCase();
  return (SUPPORTED_CURRENCY_CODES as readonly string[]).includes(upper)
    ? (upper as CurrencyCode)
    : CURRENCY_USD;
}

export function getCurrencySymbol(code: any): string {
  const key = typeof code === "string" ? (code.trim().toUpperCase() as CurrencyCode) : CURRENCY_USD;
  return CURRENCY_META[key]?.symbol ?? "$";
}

export function getCurrencyLabelKey(code: CurrencyCode): string {
  return CURRENCY_META[code]?.labelKey ?? CURRENCY_META.USD.labelKey;
}

export function getSupportedCurrencies(): Array<{
  code: CurrencyCode;
  symbol: string;
  labelKey: string;
}> {
  return SUPPORTED_CURRENCY_CODES.map((code) => ({ code, ...CURRENCY_META[code] }));
}

function getNavigatorLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) {
    return navigator.languages.filter((value) => typeof value === "string");
  }
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

/**
 * When the user has never picked a currency, default INR for India-region
 * browser locales (en-IN, hi-IN, …). Otherwise USD.
 */
export function inferDefaultCurrencyFromLocale(
  languages: string[] = getNavigatorLanguages(),
): CurrencyCode {
  for (const tag of languages) {
    const normalized = String(tag || "").trim();
    if (!normalized) continue;
    try {
      const locale = new Intl.Locale(normalized);
      if (locale.region === "IN") return "INR";
    } catch {
      if (/-IN$/i.test(normalized)) return "INR";
    }
  }
  return CURRENCY_USD;
}

export function getInitialCurrency(): CurrencyCode {
  const stored = safeGetItem(CURRENCY_STORAGE_KEY);
  if (stored != null && String(stored).trim() !== "") {
    return normalizeCurrency(stored);
  }
  return inferDefaultCurrencyFromLocale();
}

export function persistCurrency(value: any): boolean {
  return safeSetItem(CURRENCY_STORAGE_KEY, normalizeCurrency(value));
}

function normalizeRateSource(value: any): RateSource {
  return value === "fetched" ? "fetched" : "default";
}

function parseRatesBlob(raw: any): Record<string, number> | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) out[k.toUpperCase()] = num;
    }
    return out;
  } catch {
    return null;
  }
}

export function getInitialExchangeRates(): ExchangeRatesState {
  const stored = parseRatesBlob(safeGetItem(EXCHANGE_RATES_STORAGE_KEY));
  const tsRaw = safeGetItem(EXCHANGE_RATE_FETCHED_AT_STORAGE_KEY);
  const ts = tsRaw == null ? NaN : Number(tsRaw);
  const fetchedAt = Number.isFinite(ts) && ts > 0 ? ts : null;
  const sourceRaw = safeGetItem(EXCHANGE_RATE_SOURCE_STORAGE_KEY);
  const source = normalizeRateSource(sourceRaw);
  if (stored && Object.keys(stored).length > 0) {
    return { rates: { USD: 1, ...stored }, source, fetchedAt };
  }
  return { rates: { ...DEFAULT_RATES }, source: "default", fetchedAt: null };
}

export function persistExchangeRates(state: ExchangeRatesState): boolean {
  const { rates, source, fetchedAt } = state;
  if (!rates || typeof rates !== "object") return false;
  const ok1 = safeSetItem(EXCHANGE_RATES_STORAGE_KEY, JSON.stringify(rates));
  const ok2 = safeSetItem(EXCHANGE_RATE_SOURCE_STORAGE_KEY, normalizeRateSource(source));
  const ok3 = fetchedAt
    ? safeSetItem(EXCHANGE_RATE_FETCHED_AT_STORAGE_KEY, String(fetchedAt))
    : true;
  return ok1 && ok2 && ok3;
}

export function getRateFor(rates: Record<string, number> | null | undefined, code: CurrencyCode): number {
  if (code === CURRENCY_USD) return 1;
  const fromMap = rates?.[code];
  if (isValidRate(fromMap)) return fromMap;
  const fallback = DEFAULT_RATES[code];
  return isValidRate(fallback) ? fallback : 1;
}

/**
 * Apply currency conversion to a USD value. Returns the converted numeric
 * value and the appropriate symbol. Formatting is the caller's job.
 */
export function applyCurrency(
  usdValue: number,
  code: CurrencyCode,
  rates: Record<string, number> | null | undefined,
): { value: number; symbol: string } {
  const symbol = getCurrencySymbol(code);
  if (code === CURRENCY_USD) return { value: usdValue, symbol };
  const rate = getRateFor(rates, code);
  return { value: usdValue * rate, symbol };
}
