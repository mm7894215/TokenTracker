import React, { useEffect, useState } from "react";
import { FlaskConical, Gauge, Monitor, Palette, UserRound } from "lucide-react";
import { LimitsSettingsPanel } from "../components/LimitsSettingsPanel.jsx";
import { AccountSection } from "../components/settings/AccountSection.jsx";
import { AppearanceSection } from "../components/settings/AppearanceSection.jsx";
import { LabsSection } from "../components/settings/LabsSection.jsx";
import { SectionCard, SegmentedControl } from "../components/settings/Controls.jsx";
import { MenuBarSection, NativeAppFooter } from "../components/settings/MenuBarSection.jsx";
import { LIMIT_DISPLAY_MODES, useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { cn } from "../lib/cn";
import { copy } from "../lib/copy";
import { isBridgeAvailable, isNativeApp } from "../lib/native-bridge";

const SETTINGS_SECTION_IDS = {
  APPEARANCE: "appearance",
  NATIVE_APP: "native-app",
  ACCOUNT: "account",
  LIMITS: "limits",
  LABS: "labs",
};

function LimitsDisplayModeControl({ prefs }) {
  return (
    <SegmentedControl
      options={[
        { value: LIMIT_DISPLAY_MODES.USED, label: copy("limits.settings.display_mode_used") },
        { value: LIMIT_DISPLAY_MODES.REMAINING, label: copy("limits.settings.display_mode_remaining") },
      ]}
      value={prefs.displayMode}
      onChange={prefs.setDisplayMode}
    />
  );
}

export function SettingsPage() {
  const limitsPrefs = useLimitsDisplayPrefs();
  const nativeSettingsAvailable = isNativeApp() && isBridgeAvailable();
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTION_IDS.APPEARANCE);

  const sections = [
    {
      id: SETTINGS_SECTION_IDS.APPEARANCE,
      label: copy("settings.section.appearance"),
      Icon: Palette,
      content: <AppearanceSection />,
    },
    ...(nativeSettingsAvailable
      ? [{
          id: SETTINGS_SECTION_IDS.NATIVE_APP,
          label: copy("settings.section.menubar"),
          Icon: Monitor,
          content: <MenuBarSection />,
        }]
      : []),
    {
      id: SETTINGS_SECTION_IDS.ACCOUNT,
      label: copy("settings.section.account"),
      Icon: UserRound,
      content: <AccountSection />,
    },
    {
      id: SETTINGS_SECTION_IDS.LIMITS,
      label: copy("settings.section.limits"),
      Icon: Gauge,
      content: (
        <SectionCard
          title={copy("settings.section.limits")}
          action={<LimitsDisplayModeControl prefs={limitsPrefs} />}
        >
          <LimitsSettingsPanel prefs={limitsPrefs} />
        </SectionCard>
      ),
    },
    {
      id: SETTINGS_SECTION_IDS.LABS,
      label: copy("settings.section.labs"),
      Icon: FlaskConical,
      content: <LabsSection />,
    },
  ];

  useEffect(() => {
    if (activeSection === SETTINGS_SECTION_IDS.NATIVE_APP && !nativeSettingsAvailable) {
      setActiveSection(SETTINGS_SECTION_IDS.APPEARANCE);
    }
  }, [activeSection, nativeSettingsAvailable]);

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <div className="mb-7">
            <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
              {copy("settings.page.title")}
            </h1>
          </div>

          <div className="grid min-w-0 gap-6 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
            <aside className="min-w-0 border-b border-oai-gray-200 pb-3 dark:border-oai-gray-800 md:border-b-0 md:border-r md:pb-0 md:pr-5">
              <nav
                aria-label={copy("settings.page.title")}
                className="flex gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:sticky md:top-6 md:flex-col md:gap-1 md:overflow-visible"
              >
                {sections.map(({ id, label, Icon }) => {
                  const active = activeSection === id;
                  return (
                    <button
                      key={id}
                      id={`settings-nav-${id}`}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      aria-controls={`settings-panel-${id}`}
                      onClick={() => setActiveSection(id)}
                      className={cn(
                        "inline-flex min-h-10 min-w-max shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 md:w-full md:min-w-0 md:gap-2 md:px-3",
                        active
                          ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-white"
                          : "text-oai-gray-500 hover:bg-oai-gray-50 hover:text-oai-gray-900 dark:text-oai-gray-400 dark:hover:bg-oai-gray-900 dark:hover:text-oai-gray-200",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          active ? "text-oai-black dark:text-white" : "text-oai-gray-400 dark:text-oai-gray-500",
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <div className="min-w-0">
              {sections.map(({ id, label, content }) => (
                <section
                  key={id}
                  id={`settings-panel-${id}`}
                  aria-labelledby={`settings-nav-${id}`}
                  aria-label={label}
                  data-settings-panel={id}
                  hidden={activeSection !== id}
                >
                  {content}
                </section>
              ))}

              <NativeAppFooter />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
