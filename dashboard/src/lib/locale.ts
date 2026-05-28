import { safeGetItem, safeSetItem } from "./safe-browser";

export const LOCALE_STORAGE_KEY = "tokentracker-locale";
export const SYSTEM_LOCALE = "system";
export const EN_LOCALE = "en";
export const ZH_CN_LOCALE = "zh-CN";
export const ZH_TW_LOCALE = "zh-TW";
export const JA_LOCALE = "ja";
export const KO_LOCALE = "ko";

// Traditional-Chinese script (Hant) or Traditional-Chinese regions (Taiwan, Hong Kong, Macau).
// Everything else under zh-* (zh, zh-Hans, zh-CN, zh-SG, …) resolves to Simplified.
const TRADITIONAL_CHINESE_TAG = /^zh[-_](hant|tw|hk|mo)\b/i;

// Map a BCP-47-ish language tag to a supported resolved locale, or null if unsupported.
function classifyLanguageTag(tag: string): string | null {
  if (/^zh(?:[-_]|$)/i.test(tag)) {
    return TRADITIONAL_CHINESE_TAG.test(tag) ? ZH_TW_LOCALE : ZH_CN_LOCALE;
  }
  if (/^ja(?:[-_]|$)/i.test(tag)) return JA_LOCALE;
  if (/^ko(?:[-_]|$)/i.test(tag)) return KO_LOCALE;
  return null;
}

export function normalizeResolvedLocale(value: any) {
  if (typeof value !== "string") return EN_LOCALE;
  return classifyLanguageTag(value.trim()) || EN_LOCALE;
}

export function normalizeLocalePreference(value: any) {
  if (value === SYSTEM_LOCALE) return SYSTEM_LOCALE;
  return normalizeResolvedLocale(value);
}

function getBrowserLanguages() {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) {
    return navigator.languages.filter((value) => typeof value === "string");
  }
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

export function resolvePreferredLocale(preference: any, languages = getBrowserLanguages()) {
  const normalized = normalizeLocalePreference(preference);
  if (normalized !== SYSTEM_LOCALE) return normalized;
  // Use only the primary (most preferred) language, not any zh entry in the list.
  // Many English macOS users keep zh-Hans-CN as a secondary language for input methods or
  // fallback menus — scanning the whole array mis-resolves their primary "en" to Chinese.
  // See issue #54.
  const primary = languages
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  if (!primary) return EN_LOCALE;
  return classifyLanguageTag(primary) || EN_LOCALE;
}

export function getInitialLocalePreference() {
  return normalizeLocalePreference(safeGetItem(LOCALE_STORAGE_KEY) || SYSTEM_LOCALE);
}

export function persistLocalePreference(preference: any) {
  return safeSetItem(LOCALE_STORAGE_KEY, normalizeLocalePreference(preference));
}
