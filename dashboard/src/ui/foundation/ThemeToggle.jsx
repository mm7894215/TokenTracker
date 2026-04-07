import React, { useCallback, useEffect, useRef, useState } from "react";

const ICON_SIZE = 18;

function SunIcon() {
  return (
    <svg aria-hidden width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg aria-hidden width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" /><path d="M12 17v4" />
    </svg>
  );
}

const OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

function currentIcon(resolvedTheme) {
  return resolvedTheme === "dark" ? MoonIcon : SunIcon;
}

/**
 * Theme dropdown: Light / Dark / System.
 * Stores preference in localStorage via ThemeProvider.
 */
export function ThemeToggle({ theme, resolvedTheme, onSetTheme, className = "", direction = "down", align = "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  const ActiveIcon = currentIcon(resolvedTheme);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label="Theme"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-9 h-9 rounded-lg text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors"
      >
        <ActiveIcon />
      </button>

      {open && (
        <div
          className={`absolute z-50 min-w-[140px] py-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 shadow-lg ${
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "left" ? "left-0" : "right-0"}`}
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => { onSetTheme(value); close(); }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                  active
                    ? "text-oai-black dark:text-white bg-oai-gray-100 dark:bg-oai-gray-800"
                    : "text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60 hover:text-oai-black dark:hover:text-white"
                }`}
              >
                <Icon />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ThemeToggle;
