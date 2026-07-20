import React from "react";
import { copy } from "../../lib/copy";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";
import { useQualityPerDollarPref } from "../../hooks/use-quality-per-dollar-pref.js";
import { useSessionEfficiencyPref } from "../../hooks/use-session-efficiency-pref.js";

function BetaLabel({ labelKey }) {
  return (
    <div className="flex items-center gap-1.5">
      <span>{copy(labelKey)}</span>
      <span className="px-1.5 py-0.5 text-[8px] font-semibold tracking-wider text-oai-gray-500 bg-oai-gray-100 dark:text-oai-gray-400 dark:bg-oai-gray-800/80 rounded uppercase scale-90 origin-left">
        {copy("qpd.card.badge")}
      </span>
    </div>
  );
}

/**
 * Experimental features. Everything here works on local data alone, so the
 * section must stay reachable without signing in.
 */
export function LabsSection() {
  const { enabled: qpdEnabled, toggle: toggleQpd } = useQualityPerDollarPref();
  const { enabled: sessionsEnabled, toggle: toggleSessions } = useSessionEfficiencyPref();

  return (
    <SectionCard title={copy("settings.section.labs")}>
      <SettingsRow
        label={<BetaLabel labelKey="settings.labs.qpd.label" />}
        hint={copy("settings.labs.qpd.hint")}
        control={
          <ToggleSwitch
            checked={qpdEnabled}
            onChange={toggleQpd}
            ariaLabel={copy("settings.labs.qpd.aria")}
          />
        }
      />
      <SettingsRow
        label={<BetaLabel labelKey="settings.labs.sessions.label" />}
        hint={copy("settings.labs.sessions.hint")}
        control={
          <ToggleSwitch
            checked={sessionsEnabled}
            onChange={toggleSessions}
            ariaLabel={copy("settings.labs.sessions.aria")}
          />
        }
      />
    </SectionCard>
  );
}
