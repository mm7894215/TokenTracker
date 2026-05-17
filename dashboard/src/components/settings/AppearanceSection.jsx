import React from "react";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../../hooks/useTheme.js";
import { useLocale } from "../../hooks/useLocale.js";
import { EN_LOCALE, SYSTEM_LOCALE, ZH_CN_LOCALE } from "../../lib/locale";
import { copy } from "../../lib/copy";
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
    { value: SYSTEM_LOCALE, label: copy("settings.appearance.language.system"), Icon: Monitor },
    { value: EN_LOCALE, label: copy("settings.appearance.language.english"), Icon: Languages },
    { value: ZH_CN_LOCALE, label: copy("settings.appearance.language.chinese"), Icon: Languages },
  ];
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();

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
        control={<SegmentedControl options={buildLanguageOptions()} value={locale} onChange={setLocale} />}
      />
    </SectionCard>
  );
}
