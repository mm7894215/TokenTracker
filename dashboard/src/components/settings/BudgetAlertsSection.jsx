import React, { useCallback, useId, useState } from "react";

import { copy } from "../../lib/copy";
import {
  getBudgetAlertPrefs,
  setBudgetAlertPrefs,
} from "../../lib/budget-alerts.js";
import { SectionCard, SettingsRow } from "./Controls.jsx";

export function BudgetAlertsSection() {
  const [prefs, setPrefs] = useState(() => getBudgetAlertPrefs());

  const updateField = useCallback(
    (key, value) => {
      const next = setBudgetAlertPrefs({ ...prefs, [key]: value });
      setPrefs(next);
    },
    [prefs],
  );

  return (
    <SectionCard
      title={copy("settings.section.budgets")}
      subtitle={copy("settings.section.budgetsSubtitle")}
    >
      <BudgetSettingsRow
        label={copy("settings.budget.daily")}
        hint={copy("settings.budget.dailyHint")}
        value={prefs.daily}
        onChange={(value) => updateField("daily", value)}
      />
      <BudgetSettingsRow
        label={copy("settings.budget.weekly")}
        hint={copy("settings.budget.weeklyHint")}
        value={prefs.weekly}
        onChange={(value) => updateField("weekly", value)}
      />
      <BudgetSettingsRow
        label={copy("settings.budget.monthly")}
        hint={copy("settings.budget.monthlyHint")}
        value={prefs.monthly}
        onChange={(value) => updateField("monthly", value)}
      />
    </SectionCard>
  );
}

function BudgetSettingsRow({ label, hint, value, onChange }) {
  const labelId = useId();
  const hintId = useId();
  return (
    <SettingsRow
      label={<span id={labelId}>{label}</span>}
      hint={hint ? <span id={hintId}>{hint}</span> : null}
      control={
        <BudgetInput
          value={value}
          onChange={onChange}
          ariaLabelledBy={labelId}
          ariaDescribedBy={hint ? hintId : undefined}
        />
      }
    />
  );
}

function BudgetInput({ value, onChange, ariaLabelledBy, ariaDescribedBy }) {
  return (
    <input
      type="number"
      min="0"
      step="1"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder="0"
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className="w-24 rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-transparent px-2.5 py-1.5 text-right text-sm text-oai-black dark:text-white outline-none focus:border-oai-brand-500 focus:ring-1 focus:ring-inset focus:ring-oai-brand-500"
    />
  );
}
