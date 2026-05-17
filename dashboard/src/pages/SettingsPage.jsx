import React from "react";
import { LimitsSettingsPanel } from "../components/LimitsSettingsPanel.jsx";
import { AccountSection } from "../components/settings/AccountSection.jsx";
import { AppearanceSection } from "../components/settings/AppearanceSection.jsx";
import { SectionCard } from "../components/settings/Controls.jsx";
import { MenuBarSection, NativeAppFooter } from "../components/settings/MenuBarSection.jsx";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";

export function SettingsPage() {
  const limitsPrefs = useLimitsDisplayPrefs();

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
              {copy("settings.page.title")}
            </h1>
            <p className="mt-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              {copy("settings.page.subtitle")}
            </p>
          </div>

          <div className="space-y-4">
            <AppearanceSection />
            <MenuBarSection />
            <AccountSection />
            <SectionCard title={copy("settings.section.limits")}>
              <LimitsSettingsPanel prefs={limitsPrefs} />
            </SectionCard>
          </div>

          <NativeAppFooter />
        </div>
      </main>
    </div>
  );
}
