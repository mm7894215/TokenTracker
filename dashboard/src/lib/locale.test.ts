import { describe, expect, it } from "vitest";
import {
  EN_LOCALE,
  JA_LOCALE,
  KO_LOCALE,
  ZH_CN_LOCALE,
  ZH_TW_LOCALE,
  normalizeResolvedLocale,
  resolvePreferredLocale,
  SYSTEM_LOCALE,
} from "./locale";

describe("resolvePreferredLocale (system / Default)", () => {
  it("uses Simplified Chinese when the primary preferred language is a Simplified zh tag", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-Hans-CN", "en-US"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-CN"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-SG"])).toBe(ZH_CN_LOCALE);
  });

  it("uses Traditional Chinese for Hant script or Taiwan/Hong Kong/Macau regions", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-TW"])).toBe(ZH_TW_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-Hant"])).toBe(ZH_TW_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-Hant-HK", "en-US"])).toBe(ZH_TW_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-MO"])).toBe(ZH_TW_LOCALE);
  });

  it("uses English when the primary preferred language is en, even if zh is in the list (issue #54)", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en-US", "zh-Hans-CN"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en", "zh-Hans", "ja"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en-GB", "zh-CN", "fr-FR"])).toBe(EN_LOCALE);
  });

  it("falls back to English when languages list is empty", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, [])).toBe(EN_LOCALE);
  });

  it("uses Japanese or Korean when the primary preferred language is ja/ko", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["ja-JP", "en-US"])).toBe(JA_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["ja"])).toBe(JA_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["ko-KR"])).toBe(KO_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["ko"])).toBe(KO_LOCALE);
  });

  it("uses English for any other unsupported primary language", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["fr-FR"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["it-IT"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["de"])).toBe(EN_LOCALE);
  });

  it("ignores empty/whitespace primary entry and treats next as primary", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["", "zh-CN"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["   ", "en-US"])).toBe(EN_LOCALE);
  });

  it("respects explicit non-system preferences without consulting the languages list", () => {
    expect(resolvePreferredLocale("en", ["zh-CN"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale("zh-CN", ["en-US"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale("zh-TW", ["en-US"])).toBe(ZH_TW_LOCALE);
  });
});

describe("normalizeResolvedLocale", () => {
  it("keeps Simplified and Traditional Chinese distinct", () => {
    expect(normalizeResolvedLocale("zh-CN")).toBe(ZH_CN_LOCALE);
    expect(normalizeResolvedLocale("zh-TW")).toBe(ZH_TW_LOCALE);
    expect(normalizeResolvedLocale("zh-Hant")).toBe(ZH_TW_LOCALE);
    expect(normalizeResolvedLocale("zh")).toBe(ZH_CN_LOCALE);
    expect(normalizeResolvedLocale("ja-JP")).toBe(JA_LOCALE);
    expect(normalizeResolvedLocale("ko")).toBe(KO_LOCALE);
    expect(normalizeResolvedLocale("en")).toBe(EN_LOCALE);
    expect(normalizeResolvedLocale(null)).toBe(EN_LOCALE);
  });
});
