import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { copy } from "../../../lib/copy.ts";

const DISMISS_KEY = "widgetOnboardingDismissed";
const NATIVE_APP_KEY = "tokentracker_native_app";

/** True when loaded inside the native macOS app (WKWebView with ?app=1). */
const isNativeApp = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("app") === "1") {
      localStorage.setItem(NATIVE_APP_KEY, "1");
      return true;
    }
    return localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch {
    return false;
  }
})();

/**
 * Promotes the macOS desktop widgets bundled with TokenTrackerBar 0.5.38+.
 * Only renders inside the native app — widgets are macOS-only.
 * Dismissible; remembers the choice via localStorage.
 */
export function WidgetOnboardingCard({ enterDelay = 0 }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage failures; the card can reappear next session.
    }
  }, []);

  if (!isNativeApp) return null;

  return (
    <AnimatePresence initial={false}>
      {!dismissed && (
        <motion.div
          key="widget-onboarding-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } }}
          transition={{ duration: 0.35, delay: enterDelay, ease: [0.16, 1, 0.3, 1] }}
          className="relative rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4"
        >
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={copy("dashboard.widgets.dismiss_aria")}
            className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-300 dark:focus-visible:ring-oai-gray-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <div className="rounded-lg overflow-hidden ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
            <img
              src="/widgets-overview.png"
              alt={copy("dashboard.widgets.title")}
              width={734}
              height={552}
              className="w-full h-auto block"
              loading="lazy"
              decoding="async"
            />
          </div>

          <div className="mt-4">
            <div className="text-sm font-medium tracking-tight text-oai-gray-900 dark:text-oai-white">
              {copy("dashboard.widgets.title")}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-1 leading-snug">
              {copy("dashboard.widgets.hint")}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
