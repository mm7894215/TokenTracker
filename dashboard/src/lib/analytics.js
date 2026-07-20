import { isNativeEmbed, isNativeWindowsApp } from "./native-bridge.js";

/**
 * Anonymous product analytics (PostHog), covering all four dashboard
 * surfaces: the hosted site, localhost (npm CLI users), and the macOS /
 * Windows app WebViews. Every event carries a `shell` property so the
 * surfaces can be split apart in PostHog.
 *
 * Privacy contract (disclosed in the README privacy section):
 * - pageviews + explicitly captured events only — autocapture and session
 *   recording are off, browser Do-Not-Track is respected;
 * - on localhost / native-app surfaces the local server's
 *   /functions/tokentracker-telemetry-pref is consulted first, so
 *   TOKENTRACKER_NO_TELEMETRY=1 (or DO_NOT_TRACK=1 / config
 *   `"telemetry": false`) disables dashboard analytics together with the
 *   daily heartbeat. If the preference cannot be confirmed, analytics stays
 *   OFF (fail-closed).
 */

// Public project write key (phc_*) — ships in every browser bundle by design
// and cannot read any data. Hardcoded rather than injected via VITE_ env so
// release builds (Vercel, DMG / Windows embedded dashboard, npm package)
// can't silently lose analytics to a missing CI env var.
const POSTHOG_KEY =
  import.meta.env.VITE_POSTHOG_KEY || "phc_nXhUfFbyrW9gNvp8iBL83eWPUhAuAYJgcgqUJxwUbBgj";
const POSTHOG_HOST = "https://us.i.posthog.com";

export function resolveAnalyticsShell() {
  if (typeof window === "undefined") return "web";
  if (isNativeEmbed()) return "mac-app";
  if (isNativeWindowsApp()) return "win-app";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "cli-localhost";
  return "web";
}

async function startPosthog(shell) {
  // Dynamic import keeps posthog-js (~70-90 KB gzip) out of the eager entry
  // chunk — analytics only ever activates in production builds, so localhost
  // CLI users, native WebViews, and the share page should not pay for it.
  const { default: posthog } = await import("posthog-js");
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: "history_change", // SPA route changes count as pageviews
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
    persistence: "localStorage",
  });
  posthog.register({ shell });
}

export function initAnalytics() {
  if (typeof window === "undefined") return;
  // Vite dev server (5173 mock mode) and vitest must never emit events.
  if (import.meta.env.DEV || import.meta.env.MODE === "test") return;

  try {
    const shell = resolveAnalyticsShell();
    if (shell === "web") {
      void startPosthog(shell).catch(() => {
        /* analytics must never break the app */
      });
      return;
    }
    // Local surfaces: honor the CLI-side telemetry opt-out, fail-closed.
    fetch("/functions/tokentracker-telemetry-pref")
      .then((res) => (res.ok ? res.json() : null))
      .then((pref) => {
        if (pref && pref.disabled === false) {
          return startPosthog(shell);
        }
        return undefined;
      })
      .catch(() => {
        /* preference unknown → analytics stays off */
      });
  } catch {
    /* analytics must never break the app */
  }
}
