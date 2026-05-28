import React from "react";
import { ChevronDown, Info, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../../hooks/useTheme.js";
import { useLocale } from "../../hooks/useLocale.js";
import { useCurrency } from "../../hooks/useCurrency.js";
import { EN_LOCALE, JA_LOCALE, KO_LOCALE, SYSTEM_LOCALE, ZH_CN_LOCALE, ZH_TW_LOCALE } from "../../lib/locale";
import { CURRENCY_USD, getSupportedCurrencies } from "../../lib/currency";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { SectionCard, SegmentedControl, SettingsRow } from "./Controls.jsx";

function buildThemeOptions() {
  return [
    { value: "light", label: copy("settings.appearance.theme.light"), Icon: Sun },
    { value: "dark", label: copy("settings.appearance.theme.dark"), Icon: Moon },
    { value: "system", label: copy("settings.appearance.theme.system"), Icon: Monitor },
  ];
}

function buildLanguageOptions() {
  return [
    { value: SYSTEM_LOCALE, label: copy("settings.appearance.language.system") },
    { value: EN_LOCALE, label: copy("settings.appearance.language.english") },
    { value: ZH_CN_LOCALE, label: copy("settings.appearance.language.chinese") },
    { value: ZH_TW_LOCALE, label: copy("settings.appearance.language.traditional_chinese") },
    { value: JA_LOCALE, label: copy("settings.appearance.language.japanese") },
    { value: KO_LOCALE, label: copy("settings.appearance.language.korean") },
  ];
}

function formatUpdatedAt(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
  } catch {
    return null;
  }
}

function buildSourceTooltip(rateSource, rateFetchedAt) {
  const source = copy(`settings.appearance.currency.rate_source.${rateSource}`);
  const updatedAt = formatUpdatedAt(rateFetchedAt);
  const when = updatedAt
    ? copy("settings.appearance.currency.rate_updated", { when: updatedAt })
    : copy("settings.appearance.currency.rate_never");
  return `${source} · ${when}`;
}

function LanguageDropdown({ locale, setLocale }) {
  const options = buildLanguageOptions();
  return (
    <div className="relative inline-flex">
      <Languages
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-500 dark:text-oai-gray-400"
        aria-hidden
      />
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        aria-label={copy("settings.appearance.language.label")}
        className={cn(
          "appearance-none rounded-lg border border-oai-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs font-medium text-oai-black",
          "transition-colors hover:bg-oai-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
          "dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white dark:hover:bg-oai-gray-800",
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-500 dark:text-oai-gray-400"
        aria-hidden
      />
    </div>
  );
}

function CurrencyDropdown({ currency, setCurrency }) {
  const options = getSupportedCurrencies();
  return (
    <div className="relative inline-flex">
      <select
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
        aria-label={copy("settings.appearance.currency.label")}
        className={cn(
          "appearance-none rounded-lg border border-oai-gray-200 bg-white py-1.5 pl-3 pr-8 text-xs font-medium text-oai-black",
          "transition-colors hover:bg-oai-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
          "dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white dark:hover:bg-oai-gray-800",
        )}
      >
        {options.map((opt) => (
          <option key={opt.code} value={opt.code}>
            {copy(opt.labelKey)}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-500 dark:text-oai-gray-400"
        aria-hidden
      />
    </div>
  );
}

function CurrencyHint({ currency, rate, rateSource, rateFetchedAt }) {
  if (currency === CURRENCY_USD) {
    return <>{copy("settings.appearance.currency.hint")}</>;
  }
  const tooltip = buildSourceTooltip(rateSource, rateFetchedAt);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{`1 USD = ${rate.toFixed(4)} ${currency}`}</span>
      <span
        role="img"
        aria-label={tooltip}
        title={tooltip}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center text-oai-gray-400 hover:text-oai-gray-600 dark:text-oai-gray-500 dark:hover:text-oai-gray-300"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </span>
    </span>
  );
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const { currency, rate, rateSource, rateFetchedAt, setCurrency } = useCurrency();

  return (
    <SectionCard title={copy("settings.section.appearance")}>
      <SettingsRow
        label={copy("settings.appearance.theme.label")}
        hint={copy("settings.appearance.theme.hint")}
        control={<SegmentedControl options={buildThemeOptions()} value={theme} onChange={setTheme} />}
      />
      <SettingsRow
        label={copy("settings.appearance.language.label")}
        hint={copy("settings.appearance.language.hint")}
        control={<LanguageDropdown locale={locale} setLocale={setLocale} />}
      />
      <SettingsRow
        label={copy("settings.appearance.currency.label")}
        hint={
          <CurrencyHint
            currency={currency}
            rate={rate}
            rateSource={rateSource}
            rateFetchedAt={rateFetchedAt}
          />
        }
        control={<CurrencyDropdown currency={currency} setCurrency={setCurrency} />}
      />
    </SectionCard>
  );
}
