import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useLoginModal } from "../../../contexts/LoginModalContext.jsx";
import { useInsforgeAuth } from "../../../contexts/InsforgeAuthContext.jsx";

const DISMISS_KEY = "macAppBannerDismissed";
const LOGIN_DISMISS_KEY = "leaderboardBannerDismissed";
const RELEASE_URL = "https://github.com/mm7894215/tokentracker/releases/latest";

/** True when loaded inside the native macOS app (WKWebView with ?app=1) */
const NATIVE_APP_KEY = "tokentracker_native_app";
const isNativeApp = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("app") === "1") {
      localStorage.setItem(NATIVE_APP_KEY, "1");
      return true;
    }
    return localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch { return false; }
})();

/**
 * Clawd pixel-art SVG component — the 15×16 character drawn as rects.
 * Matches clawd-static-base.svg from Clawd-on-Desk.
 */
function ClawdPixel({ size = 48, className = "" }) {
  const scale = size / 16;
  const [eyesClosed, setEyesClosed] = useState(false);

  useEffect(() => {
    const blink = () => {
      const delay = 2500 + Math.random() * 3000;
      const timer = setTimeout(() => {
        setEyesClosed(true);
        setTimeout(() => {
          setEyesClosed(false);
          blink();
        }, 120);
      }, delay);
      return timer;
    };
    const timer = blink();
    return () => clearTimeout(timer);
  }, []);

  const bodyColor = "#DE886D";
  const eyeColor = "#000000";

  return (
    <svg
      width={15 * scale}
      height={10 * scale}
      viewBox="0 5.5 15 10"
      className={className}
      style={{ imageRendering: "pixelated" }}
    >
      {/* Torso */}
      <rect x="2" y="6" width="11" height="7" fill={bodyColor} />
      {/* Arms */}
      <rect x="0" y="9" width="2" height="2" fill={bodyColor} />
      <rect x="13" y="9" width="2" height="2" fill={bodyColor} />
      {/* Legs */}
      <rect x="3" y="13" width="1" height="2" fill={bodyColor} />
      <rect x="5" y="13" width="1" height="2" fill={bodyColor} />
      <rect x="9" y="13" width="1" height="2" fill={bodyColor} />
      <rect x="11" y="13" width="1" height="2" fill={bodyColor} />
      {/* Shadow */}
      <rect x="3" y="15" width="9" height="1" fill="#000" opacity="0.12" />
      {/* Eyes */}
      {eyesClosed ? (
        <>
          <rect x="4" y="9" width="1" height="0.4" fill={eyeColor} />
          <rect x="10" y="9" width="1" height="0.4" fill={eyeColor} />
        </>
      ) : (
        <>
          <rect x="4" y="8" width="1" height="2" fill={eyeColor} />
          <rect x="10" y="8" width="1" height="2" fill={eyeColor} />
        </>
      )}
    </svg>
  );
}

/**
 * Context-aware banner:
 * - Native app + signed in → Leaderboard entry
 * - Native app + not signed in → Login CTA
 * - Browser → Download App CTA
 */
export function MacAppBanner() {
  const { openLoginModal } = useLoginModal();
  const { signedIn: cloudSignedIn } = useInsforgeAuth();
  const dismissKey = isNativeApp ? LOGIN_DISMISS_KEY : DISMISS_KEY;

  const [dismissed, setDismissed] = useState(() => {
    try {
      if (localStorage.getItem(dismissKey) === "1") return true;
      if (!isNativeApp && new URLSearchParams(window.location.search).get("from") === "menubar") {
        localStorage.setItem(DISMISS_KEY, "1");
        return true;
      }
      return false;
    } catch { return false; }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(dismissKey, "1"); } catch {}
  }, [dismissKey]);

  if (dismissed) return null;

  // Determine banner content based on context
  let title, subtitle, buttonLabel, buttonIcon, onButtonClick, buttonHref;

  if (isNativeApp && cloudSignedIn) {
    title = "View the Leaderboard";
    subtitle = "Compare your usage globally";
    buttonLabel = "Leaderboard";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M2 8.5V10h8V8.5M6 1.5v6m0 0L3.5 5M6 7.5l2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 6 6)"/>
      </svg>
    );
    onButtonClick = () => { window.location.pathname = "/leaderboard"; };
  } else if (isNativeApp) {
    title = "Join the Leaderboard";
    subtitle = "Log in to compare your usage with others";
    buttonLabel = "Log In";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M6.5 1.5h3a1 1 0 011 1v7a1 1 0 01-1 1h-3M5 8.5L7.5 6 5 3.5M7.5 6H1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
    onButtonClick = openLoginModal;
  } else {
    title = "Try the Menu Bar App";
    subtitle = "Always-on stats with Clawd companion";
    buttonLabel = "Download";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M6 2v6m0 0L3.5 5.5M6 8l2.5-2.5M2 10h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
    buttonHref = RELEASE_URL;
  }

  const ButtonTag = buttonHref ? motion.a : motion.button;
  const buttonProps = buttonHref
    ? { href: buttonHref, target: "_blank", rel: "noopener noreferrer" }
    : { onClick: onButtonClick };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.3 }}
        className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4"
      >
        <div className="flex items-center gap-3">
          <motion.div
            animate={{ y: [0, -2, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            className="flex-shrink-0"
          >
            <ClawdPixel size={44} />
          </motion.div>

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-oai-gray-900 dark:text-oai-white">
              {title}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-0.5">
              {subtitle}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <ButtonTag
              {...buttonProps}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {buttonLabel}
              {buttonIcon}
            </ButtonTag>
            <button
              onClick={handleDismiss}
              className="p-1 text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-300 transition-colors"
              aria-label="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
