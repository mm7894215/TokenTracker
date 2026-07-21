import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_BRANDING_STORAGE_KEY = "tt.sidebarBranding.visible";
const SIDEBAR_BRANDING_CHANGE_EVENT = "tokentracker:sidebar-branding-change";

export function readSidebarBrandingVisible() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SIDEBAR_BRANDING_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function useSidebarBranding() {
  const [visible, setVisibleState] = useState(readSidebarBrandingVisible);
  const visibleRef = useRef(visible);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refresh = () => {
      const next = readSidebarBrandingVisible();
      visibleRef.current = next;
      setVisibleState(next);
    };
    const onStorage = (event) => {
      if (event.key === null || event.key === SIDEBAR_BRANDING_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SIDEBAR_BRANDING_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SIDEBAR_BRANDING_CHANGE_EVENT, refresh);
    };
  }, []);

  const setVisible = useCallback((next) => {
    const value = typeof next === "function"
      ? Boolean(next(visibleRef.current))
      : Boolean(next);
    visibleRef.current = value;
    setVisibleState(value);
    try {
      window.localStorage.setItem(SIDEBAR_BRANDING_STORAGE_KEY, value ? "1" : "0");
      window.dispatchEvent(new CustomEvent(SIDEBAR_BRANDING_CHANGE_EVENT));
    } catch {
      // Locked-down storage should not make the appearance setting unusable.
    }
  }, []);

  const toggle = useCallback(() => setVisible((current) => !current), [setVisible]);
  return { visible, setVisible, toggle };
}
