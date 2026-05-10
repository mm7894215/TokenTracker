import React, { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { isAccessTokenReady, resolveAuthAccessTokenWithRetry } from "../lib/auth-token";
import { copy } from "../lib/copy";
import { toDisplayNumber } from "../lib/format";
import { cn } from "../lib/cn";
import { getLeaderboardBaseUrl } from "../lib/config";
import { isMockEnabled } from "../lib/mock-data";
import { getLeaderboardProfile } from "../lib/api";
import { InsforgeUserHeaderControls } from "../components/InsforgeUserHeaderControls.jsx";
import { HeaderGithubStar } from "../ui/components/HeaderGithubStar.jsx";
import { LeaderboardAvatar } from "../components/LeaderboardAvatar.jsx";
import { LeaderboardProviderColumnHeader } from "../components/LeaderboardProviderColumnHeader.jsx";
import { useTheme } from "../hooks/useTheme.js";
import { ThemeToggle } from "../ui/foundation/ThemeToggle.jsx";
import {
  LB_STICKY_TH_RANK,
  LB_STICKY_TH_TOTAL,
  LEADERBOARD_TOKEN_COLUMNS,
  lbStickyTdRank,
  lbStickyTdTotalOnly,
} from "../lib/leaderboard-columns.js";

function normalizeProfileError(err) {
  if (!err) return copy("shared.error.prefix", { error: copy("leaderboard.error.unknown") });
  const msg = err?.message || String(err);
  const safe = String(msg || "").trim() || copy("leaderboard.error.unknown");
  return copy("shared.error.prefix", { error: safe });
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizePeriod(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "week") return v;
  if (v === "month") return v;
  if (v === "total") return v;
  return null;
}

export function LeaderboardProfilePage({
  auth,
  signedIn,
  sessionSoftExpired,
  userId,
}) {
  const location = useLocation();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const leaderboardBaseUrl = useMemo(() => getLeaderboardBaseUrl(), []);
  const mockEnabled = isMockEnabled();
  const authTokenAllowed = signedIn && !sessionSoftExpired;
  const authAccessToken = useMemo(() => {
    if (!authTokenAllowed) return null;
    if (typeof auth === "function") return auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth === "object") return auth;
    return null;
  }, [auth, authTokenAllowed]);
  const effectiveAuthToken = authTokenAllowed ? authAccessToken : null;
  const authTokenReady = authTokenAllowed && isAccessTokenReady(effectiveAuthToken);
  const period = useMemo(() => {
    const params = new URLSearchParams(location?.search || "");
    return normalizePeriod(params.get("period")) || "week";
  }, [location?.search]);
  const periodSearch = location?.search || "";

  const [profileState, setProfileState] = useState(() => ({
    loading: false,
    error: null,
    data: null,
  }));

  useEffect(() => {
    if (!leaderboardBaseUrl && !mockEnabled) return;
    if (!userId) return;
    // Public profiles are visible to anonymous visitors: the backend
    // decides per-target via leaderboard_public. Only wait on the auth
    // token if we actually have an authenticated session — otherwise an
    // anonymous click on a shared profile link would stare at an empty
    // state forever.
    if (authTokenAllowed && !authTokenReady) return;
    let active = true;
    setProfileState((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      const token = authTokenAllowed
        ? await resolveAuthAccessTokenWithRetry(effectiveAuthToken)
        : null;
      if (!active) return;
      const data = await getLeaderboardProfile({
        baseUrl: leaderboardBaseUrl,
        accessToken: token,
        userId,
        period,
      });
      if (!active) return;
      setProfileState({ loading: false, error: null, data });
    })().catch((err) => {
      if (!active) return;
      // 404 means "target hasn't opted in to a public profile" — treat it
      // as an empty state, not a red error. We intentionally don't leak the
      // difference between "private" and "never ranked" to anonymous
      // visitors; both show the same neutral copy.
      if (err?.status === 404) {
        setProfileState({ loading: false, error: null, data: null });
        return;
      }
      setProfileState({ loading: false, error: normalizeProfileError(err), data: null });
    });
    return () => {
      active = false;
    };
  }, [
    authTokenAllowed,
    authTokenReady,
    leaderboardBaseUrl,
    effectiveAuthToken,
    mockEnabled,
    period,
    userId,
  ]);

  const data = profileState.data;
  const from = data?.from || null;
  const to = data?.to || null;
  const generatedAt = data?.generated_at || null;
  const entry = data?.entry || null;

  const displayName = normalizeName(entry?.display_name) || copy("leaderboard.anon_label");
  const weekLabel = copy("leaderboard.period.week");
  const monthLabel = copy("leaderboard.period.month");
  const totalLabel = copy("leaderboard.period.total");
  const periodLabel = period === "month" ? monthLabel : period === "total" ? totalLabel : weekLabel;

  let body = null;
  if (!userId) {
    body = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.empty")}</p>
      </div>
    );
  } else if (profileState.loading) {
    body = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.loading")}</p>
      </div>
    );
  } else if (profileState.error) {
    body = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-red-500 dark:text-red-400">{profileState.error}</p>
      </div>
    );
  } else if (entry) {
    body = (
      <div className="w-full overflow-x-auto">
        <table className="min-w-max w-full text-left text-sm">
          <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
            <tr>
              <th className={cn(LB_STICKY_TH_RANK, "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                {copy("leaderboard.column.rank")}
              </th>
              <th className={cn(LB_STICKY_TH_TOTAL, "font-medium text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap")}>
                {copy("leaderboard.column.total")}
              </th>
              {LEADERBOARD_TOKEN_COLUMNS.map((col) => (
                <th key={col.key} className="px-4 py-4 font-medium text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap">
                  <LeaderboardProviderColumnHeader iconSrc={col.icon} label={copy(col.copyKey)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800/50">
            <tr className="transition-colors hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/60">
              <td className={cn(lbStickyTdRank(false), "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                {entry?.rank ?? copy("shared.placeholder.short")}
              </td>
              <td className={cn(lbStickyTdTotalOnly(false), "text-oai-gray-700 dark:text-oai-gray-300")}>
                {toDisplayNumber(entry?.total_tokens)}
              </td>
              {LEADERBOARD_TOKEN_COLUMNS.map((col) => (
                <td key={col.key} className="px-4 py-4 text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap">
                  {toDisplayNumber(entry?.[col.key])}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  } else {
    body = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-oai-white dark:bg-oai-gray-950 text-oai-black dark:text-oai-white font-oai antialiased transition-colors duration-200">
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-oai-gray-950/80 backdrop-blur-md border-b border-oai-gray-200 dark:border-oai-gray-900 transition-colors duration-200">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-5">
            <Link
              to="/"
              className="flex items-center gap-3 no-underline outline-none rounded focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:ring-offset-oai-gray-950 transition-opacity hover:opacity-80"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-wide text-oai-black dark:text-white uppercase">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to={`/leaderboard${periodSearch}`}
              className="no-underline inline-flex items-center justify-center h-9 px-5 text-sm font-medium rounded-full shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 dark:bg-white text-white dark:text-oai-gray-900 hover:bg-oai-gray-800 dark:hover:bg-oai-gray-100 transition-colors"
            >
              {copy("leaderboard.profile.nav.back")}
            </Link>
            <ThemeToggle theme={theme} resolvedTheme={resolvedTheme} onSetTheme={setTheme} />
            <InsforgeUserHeaderControls />
          </div>
        </div>
      </header>

      <main className="flex-1 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-6 mb-10">
            <LeaderboardAvatar
              avatarUrl={entry?.avatar_url}
              displayName={displayName}
              seed={typeof userId === "string" ? userId : displayName}
              size="lg"
              className="shrink-0 ring-2 ring-oai-gray-200 dark:ring-oai-gray-800"
            />
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {displayName}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
                {period === "total"
                  ? copy("leaderboard.range.total")
                  : from && to
                    ? copy("leaderboard.range", { period: periodLabel, from, to })
                    : copy("leaderboard.range_loading", { period: periodLabel })}
                {generatedAt && (
                  <span className="ml-2 pl-2 border-l border-oai-gray-200 dark:border-oai-gray-800 inline-block text-oai-gray-400 dark:text-oai-gray-500 text-xs">
                    {copy("leaderboard.generated_at", { ts: generatedAt })}
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 overflow-hidden">
            {body}
          </div>
        </div>
      </main>

      <footer className="border-t border-oai-gray-200 dark:border-oai-gray-900 py-8 transition-colors duration-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 text-sm text-oai-gray-400 dark:text-oai-gray-500">
          <p>{copy("landing.v2.footer.line")}</p>
          <Link
            to={`/leaderboard${periodSearch}`}
            className="text-oai-gray-400 dark:text-oai-gray-500 hover:text-oai-black dark:hover:text-white transition-colors"
          >
            {copy("leaderboard.profile.nav.back")}
          </Link>
        </div>
      </footer>
    </div>
  );
}
