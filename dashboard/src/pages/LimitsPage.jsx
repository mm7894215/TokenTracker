import React from "react";
import { Link } from "react-router-dom";
import { Settings as SettingsIcon } from "lucide-react";
import { useUsageLimits } from "../hooks/use-usage-limits.js";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";
import { UsageLimitsPanel } from "../ui/matrix-a/components/UsageLimitsPanel.jsx";

export function LimitsPage() {
  const { data: usageLimits } = useUsageLimits();
  const prefs = useLimitsDisplayPrefs();

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-row items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("nav.limits")}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
                {copy("limits.page.subtitle")}
              </p>
            </div>
            <Link
              to="/settings"
              aria-label={copy("limits.page.openSettings")}
              title={copy("limits.page.openSettings")}
              className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
            >
              <SettingsIcon className="h-4 w-4" aria-hidden />
            </Link>
          </div>

          <UsageLimitsPanel
            claude={usageLimits?.claude}
            codex={usageLimits?.codex}
            cursor={usageLimits?.cursor}
            gemini={usageLimits?.gemini}
            kiro={usageLimits?.kiro}
            antigravity={usageLimits?.antigravity}
            order={prefs.order}
            visibility={prefs.visibility}
          />
        </div>
      </main>
    </div>
  );
}
