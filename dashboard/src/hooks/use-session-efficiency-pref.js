import { useCallback, useEffect, useState } from "react";

export const SESSION_EFFICIENCY_PREF_KEY = "tt.sessionEfficiency.enabled";

function readEnabled() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SESSION_EFFICIENCY_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function useSessionEfficiencyPref() {
  const [enabled, setEnabledState] = useState(readEnabled);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onStorage = (event) => {
      if (event.key === null || event.key === SESSION_EFFICIENCY_PREF_KEY) {
        setEnabledState(readEnabled());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((next) => {
    const value = Boolean(next);
    setEnabledState(value);
    try {
      window.localStorage.setItem(SESSION_EFFICIENCY_PREF_KEY, value ? "1" : "0");
    } catch {
      // Private browsing or quota failures should not break Settings.
    }
  }, []);

  const toggle = useCallback(() => setEnabled(!readEnabled()), [setEnabled]);
  return { enabled, setEnabled, toggle };
}
