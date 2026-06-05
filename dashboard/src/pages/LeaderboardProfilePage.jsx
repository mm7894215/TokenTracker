import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Trophy, Download } from "lucide-react";
import { MetalFx } from "metal-fx";
import { copy } from "../lib/copy";
import { isNativeApp } from "../lib/native-bridge.js";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTheme } from "../hooks/useTheme.js";
import { ThemeToggle } from "../ui/foundation/ThemeToggle.jsx";
import { InsforgeUserHeaderControls } from "../components/InsforgeUserHeaderControls.jsx";
import { HeaderGithubStar } from "../ui/components/HeaderGithubStar.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import {
  ProfileContent,
  ProfileSkeleton,
  useLeaderboardProfileData,
} from "../components/leaderboard/LeaderboardProfileModal.jsx";

const RELEASE_URL = "https://github.com/mm7894215/TokenTracker/releases/latest";

/**
 * Standalone, shareable per-user profile page at /u/:userId. Reuses the same
 * content + data hook as the leaderboard modal; renders inside a centered
 * card with its own page chrome instead of a dialog. Public profiles are
 * visible to anonymous visitors (the edge function gates per target).
 */
export function LeaderboardProfilePage({ auth, signedIn, sessionSoftExpired, userId }) {
  const { currency, rate } = useCurrency();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { openLoginModal } = useLoginModal();
  const { signedIn: realSignedIn, loading: authLoading } = useInsforgeAuth();

  // Browser visitors landing on a shared profile are prime download targets;
  // hide the CTA when already running inside the native app.
  const showDownload = !isNativeApp();

  const authTokenAllowed = signedIn && !sessionSoftExpired;
  const accessToken = useMemo(() => {
    if (!authTokenAllowed) return null;
    if (typeof auth === "function") return auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth === "object") return auth;
    return null;
  }, [auth, authTokenAllowed]);

  const state = useLeaderboardProfileData({ userId, period: "total", accessToken });

  return (
    <div className="flex flex-col min-h-screen bg-oai-gray-50 dark:bg-oai-gray-950 text-oai-black dark:text-oai-white font-oai antialiased transition-colors duration-200">
      <header className="sticky top-0 z-50 w-full px-4 pt-4 pb-2 transition-all duration-300 pointer-events-none">
        <div className="mx-auto max-w-3xl rounded-2xl border border-oai-gray-200/50 dark:border-white/10 bg-white/75 dark:bg-oai-gray-950/60 backdrop-blur-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] flex h-14 items-center justify-between px-3 sm:px-4 pointer-events-auto transition-all duration-300">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="flex items-center gap-3 no-underline outline-none rounded-md focus-visible:ring-2 focus-visible:ring-indigo-500 transition-opacity hover:opacity-80 active:scale-95"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-wide text-oai-black dark:text-white uppercase">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block scale-90 origin-left opacity-90 hover:opacity-100 transition-opacity">
              <HeaderGithubStar />
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Link
              to="/leaderboard"
              className="group no-underline inline-flex items-center gap-1.5 h-8 px-3 text-xs font-bold rounded-full border border-oai-gray-200 dark:border-white/10 bg-transparent text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-white/5 hover:text-oai-black dark:hover:text-white transition-all duration-200 active:scale-95 shadow-sm"
            >
              <Trophy
                size={13}
                strokeWidth={2.5}
                aria-hidden
                className="transition-transform duration-150 ease-out group-hover:scale-110 group-hover:rotate-6"
              />
              <span>{copy("leaderboard.profile.nav.back")}</span>
            </Link>

            {showDownload && (
              <MetalFx
                variant="button"
                preset="chromatic"
                theme="dark"
                borderRadius={9999}
                disableGlow
                className="!bg-black"
              >
                <a
                  href={RELEASE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group no-underline inline-flex h-8 items-center gap-1.5 px-3 text-xs font-bold rounded-full bg-black text-white transition-transform duration-200 active:scale-[0.98]"
                >
                  <Download
                    size={13}
                    strokeWidth={2.5}
                    aria-hidden
                    className="transition-transform duration-150 ease-out group-hover:translate-y-0.5"
                  />
                  <span className="hidden sm:inline">{copy("leaderboard.profile.nav.download")}</span>
                </a>
              </MetalFx>
            )}

            {/* 已登录时优雅渲染头像，未登录时渲染高精齐平的圆角矩形幽灵 Sign In */}
            {authLoading ? (
              <div className="h-8 w-16 animate-pulse rounded-full bg-oai-gray-200 dark:bg-white/10" aria-hidden />
            ) : realSignedIn ? (
              <InsforgeUserHeaderControls />
            ) : (
              <button
                type="button"
                onClick={openLoginModal}
                className="inline-flex h-8 min-w-[76px] items-center justify-center px-3 text-xs font-bold rounded-full border border-oai-gray-200 dark:border-white/10 bg-transparent text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-white/5 hover:text-oai-black dark:hover:text-white transition-all duration-200 active:scale-95 shadow-sm select-none"
              >
                {copy("header.auth.sign_in_aria")}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pt-4 pb-10 sm:pt-6 sm:pb-16">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl bg-white dark:bg-oai-gray-950 ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden shadow-sm dark:shadow-none">
            {state.loading && <ProfileSkeleton variant="page" />}
            {!state.loading && state.error && (
              <div className="px-6 py-16 text-center">
                <p className="text-sm text-red-500 dark:text-red-400">
                  {copy("leaderboard.profile_modal.error")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && !state.data && (
              <div className="px-6 py-16 text-center">
                <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("leaderboard.profile_modal.empty")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && state.data && (
              <ProfileContent data={state.data} currency={currency} rate={rate} variant="page" />
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-oai-gray-200 dark:border-oai-gray-900 py-8 px-4 transition-colors duration-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between text-sm text-oai-gray-400 dark:text-oai-gray-500">
          <p>{copy("landing.v2.footer.line")}</p>
          <ThemeToggle theme={theme} resolvedTheme={resolvedTheme} onSetTheme={setTheme} direction="up" align="right" />
        </div>
      </footer>
    </div>
  );
}
