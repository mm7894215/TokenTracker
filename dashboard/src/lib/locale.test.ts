import { describe, expect, it } from "vitest";
import {
  EN_LOCALE,
  ZH_CN_LOCALE,
  resolvePreferredLocale,
  SYSTEM_LOCALE,
} from "./locale";

describe("resolvePreferredLocale (system / Default)", () => {
  it("uses Chinese when the primary preferred language is zh", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-Hans-CN", "en-US"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["zh-TW"])).toBe(ZH_CN_LOCALE);
  });

  it("uses English when the primary preferred language is en, even if zh is in the list (issue #54)", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en-US", "zh-Hans-CN"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en", "zh-Hans", "ja"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["en-GB", "zh-CN", "fr-FR"])).toBe(EN_LOCALE);
  });

  it("falls back to English when languages list is empty", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, [])).toBe(EN_LOCALE);
  });

  it("uses English for any non-zh primary language", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["fr-FR"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["ja-JP"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["de"])).toBe(EN_LOCALE);
  });

  it("ignores empty/whitespace primary entry and treats next as primary", () => {
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["", "zh-CN"])).toBe(ZH_CN_LOCALE);
    expect(resolvePreferredLocale(SYSTEM_LOCALE, ["   ", "en-US"])).toBe(EN_LOCALE);
  });

  it("respects explicit non-system preferences without consulting the languages list", () => {
    expect(resolvePreferredLocale("en", ["zh-CN"])).toBe(EN_LOCALE);
    expect(resolvePreferredLocale("zh-CN", ["en-US"])).toBe(ZH_CN_LOCALE);
  });
});
