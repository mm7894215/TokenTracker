import React from "react";
import { cn } from "../../lib/cn";
import { Card } from "../../ui/components";

export function ToggleSwitch({ checked, onChange, disabled, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-700",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

export function SettingsRow({ label, hint, control }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{hint}</div>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function SectionCard({ title, subtitle, action, children }) {
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-1 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="-mb-3 divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
        {children}
      </div>
    </Card>
  );
}

export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-0.5 dark:border-oai-gray-800 dark:bg-oai-gray-900">
      {options.map(({ value: optionValue, label, Icon }) => {
        const active = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-white text-oai-black shadow-sm dark:bg-oai-gray-800 dark:text-white"
                : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
