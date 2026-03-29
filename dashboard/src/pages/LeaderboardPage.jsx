import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { isAccessTokenReady, resolveAuthAccessTokenWithRetry } from "../lib/auth-token";
import { copy } from "../lib/copy";
import { toDisplayNumber } from "../lib/format";
import { cn } from "../lib/cn";
import {
  buildPageItems,
  clampInt,
  getPaginationFlags,
  injectMeIntoFirstPage,
} from "../lib/leaderboard-ui";
import { getLeaderboardBaseUrl } from "../lib/config";
import { getDashboardEntryPath } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";
import {
  getLeaderboard,
  refreshLeaderboard,
} from "../lib/api";
import { getCloudSyncEnabled, setCloudSyncEnabled } from "../lib/cloud-sync-prefs";
import { runCloudUsageSyncNow } from "../lib/cloud-sync";
import { InsforgeUserHeaderControls } from "../components/InsforgeUserHeaderControls.jsx";
import { HeaderGithubStar } from "../ui/openai/components/HeaderGithubStar.jsx";
import { LeaderboardAvatar } from "../components/LeaderboardAvatar.jsx";
import { LeaderboardProviderColumnHeader } from "../components/LeaderboardProviderColumnHeader.jsx";
import { useTheme } from "../hooks/useTheme.js";
import { ThemeToggle } from "../ui/foundation/ThemeToggle.jsx";
import {
  LB_STICKY_TH_RANK,
  LB_STICKY_TH_USER,
  LEADERBOARD_TOKEN_COLUMNS,
  lbStickyTdRank,
  lbStickyTdUser,
} from "../lib/leaderboard-columns.js";

const PAGE_LIMIT = 20;

function formatCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 10) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function leaderboardTokenCells(entry, isMe) {
  const numCls = isMe
    ? "text-oai-gray-700 dark:text-oai-gray-300"
    : "text-oai-gray-500 dark:text-oai-gray-400";
  const cellBg = isMe
    ? "bg-oai-brand-50 dark:bg-oai-brand-900/10"
    : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60";
  return LEADERBOARD_TOKEN_COLUMNS.map((col) => (
    <td key={col.key} className={cn("px-4 py-4 whitespace-nowrap", numCls, cellBg)}>
      {toDisplayNumber(entry?.[col.key])}
    </td>
  ));
}

function normalizePeriod(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "week") return v;
  if (v === "month") return v;
  if (v === "total") return v;
  return null;
}

function normalizeLeaderboardError(err) {
  if (!err) return copy("shared.error.prefix", { error: copy("leaderboard.error.unknown") });
  const msg = err?.message || String(err);
  const safe = String(msg || "").trim() || copy("leaderboard.error.unknown");
  return copy("shared.error.prefix", { error: safe });
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isAnonymousName(value) {
  const normalized = normalizeName(value);
  if (!normalized) return true;
  return normalized.toLowerCase() === "anonymous";
}

function buildPublicViewPath(userId, search = "") {
  if (typeof userId !== "string") return null;
  const normalized = userId.trim().toLowerCase();
  if (!normalized) return null;

  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const period = normalizePeriod(params.get("period"));
  const suffix = period ? `?period=${period}` : "";

  return `/share/pv1-${normalized}${suffix}`;
}

function leaderboardAvatarSeed(entry, displayName) {
  const id = typeof entry?.user_id === "string" ? entry.user_id.trim() : "";
  if (id) return id;
  return `${entry?.rank ?? ""}:${displayName}`;
}

export function LeaderboardPage({
  auth,
  signedIn,
  sessionSoftExpired,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { openLoginModal } = useLoginModal();
  const { signedIn: cloudSignedIn, loading: authLoading } = useInsforgeAuth();
  const { resolvedTheme, toggleTheme } = useTheme();
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

  const placeholder = copy("shared.placeholder.short");
  const [listPage, setListPage] = useState(1);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [listState, setListState] = useState(() => ({
    loading: false,
    error: null,
    data: null,
  }));

  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const period = useMemo(() => {
    const params = new URLSearchParams(location?.search || "");
    return normalizePeriod(params.get("period")) || "week";
  }, [location?.search]);

  const periodSearch = location?.search || "";

  const handlePeriodChange = (nextPeriod) => {
    const normalized = normalizePeriod(nextPeriod);
    if (!normalized) return;
    if (normalized === period) return;
    const params = new URLSearchParams(location?.search || "");
    params.set("period", normalized);
    setListPage(1);
    navigate(`${location?.pathname || "/leaderboard"}?${params.toString()}`, { replace: true });
  };

  useEffect(() => {
    if (authLoading) return;
    if (mockEnabled) return;
    if (!cloudSignedIn) {
      openLoginModal();
    }
  }, [cloudSignedIn, authLoading, mockEnabled, openLoginModal]);

  useEffect(() => {
    setListPage(1);
  }, [period]);

  useEffect(() => {
    if (mockEnabled) return;
    if (!authTokenAllowed) return;
    if (authTokenReady) return;
    setListState({ loading: false, error: null, data: null });
  }, [authTokenAllowed, authTokenReady, mockEnabled]);

  const listOffset = useMemo(() => {
    const safePage = clampInt(listPage, { min: 1, max: 1_000_000, fallback: 1 });
    return (safePage - 1) * PAGE_LIMIT;
  }, [listPage]);

  useEffect(() => {
    // Mock leaderboard uses local getMockLeaderboard(); real data needs InsForge URL from getLeaderboardBaseUrl().
    if (!leaderboardBaseUrl && !mockEnabled) return;
    if (!mockEnabled && authTokenAllowed && !authTokenReady) return;
    let active = true;
    setListState((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      const token = authTokenAllowed
        ? await resolveAuthAccessTokenWithRetry(effectiveAuthToken)
        : null;
      const data = await getLeaderboard({
        baseUrl: leaderboardBaseUrl,
        accessToken: token,
        period,
        limit: PAGE_LIMIT,
        offset: listOffset,
      });
      if (!active) return;
      setListState({ loading: false, error: null, data });
    })().catch((err) => {
      if (!active) return;
      setListState({ loading: false, error: normalizeLeaderboardError(err), data: null });
    });
    return () => {
      active = false;
    };
  }, [
    leaderboardBaseUrl,
    effectiveAuthToken,
    authTokenAllowed,
    authTokenReady,
    listOffset,
    listReloadToken,
    mockEnabled,
    period,
  ]);

  const listData = listState.data;

  const totalPages = listData?.total_pages ?? null;
  const currentPage = listData?.page ?? listPage;
  const pageItems = useMemo(() => {
    return buildPageItems(currentPage, totalPages);
  }, [currentPage, totalPages]);

  const from = listData?.from || null;
  const to = listData?.to || null;
  const generatedAt = listData?.generated_at || null;
  const me = listData?.me || null;
  const meLabel = copy("leaderboard.me_label");
  const anonLabel = copy("leaderboard.anon_label");
  const weekLabel = copy("leaderboard.period.week");
  const monthLabel = copy("leaderboard.period.month");
  const totalLabel = copy("leaderboard.period.total");
  const periodLabel = period === "month" ? monthLabel : period === "total" ? totalLabel : weekLabel;

  const displayEntries = useMemo(() => {
    const rows = Array.isArray(listData?.entries) ? listData.entries : [];
    if (currentPage !== 1) return rows;
    return injectMeIntoFirstPage({
      entries: rows,
      me,
      meLabel,
      limit: PAGE_LIMIT,
    });
  }, [currentPage, listData?.entries, me, meLabel]);

  const handleEnableSync = async () => {
    setSyncing(true);
    try {
      setCloudSyncEnabled(true);
      setCloudSyncOn(true);
      await runCloudUsageSyncNow(() => resolveAuthAccessTokenWithRetry(effectiveAuthToken));
      const token = await resolveAuthAccessTokenWithRetry(effectiveAuthToken);
      if (token) await refreshLeaderboard({ accessToken: token });
      setListReloadToken((v) => v + 1);
    } catch (e) {
      console.warn("[tokentracker] sync:", e);
    } finally {
      setSyncing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const token = await resolveAuthAccessTokenWithRetry(effectiveAuthToken);
      if (cloudSyncOn && token) {
        await runCloudUsageSyncNow(() => Promise.resolve(token));
      }
      if (token) await refreshLeaderboard({ accessToken: token });
      setListReloadToken((v) => v + 1);
    } catch (e) {
      console.warn("[tokentracker] refresh:", e);
    } finally {
      setRefreshing(false);
    }
  };

  const { canPrev, canNext } = getPaginationFlags({ page: currentPage, totalPages });

  const hasEntries = Array.isArray(displayEntries) && displayEntries.length !== 0;
  let listBody = null;
  if (listState.loading) {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.loading")}</p>
      </div>
    );
  } else if (listState.error) {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-red-500 dark:text-red-400">{listState.error}</p>
      </div>
    );
  } else if (hasEntries) {
    listBody = (
      <div className="w-full overflow-x-auto">
        <table className="min-w-max w-full text-left text-sm">
          <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
            <tr>
              <th className={cn(LB_STICKY_TH_RANK, "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                {copy("leaderboard.column.rank")}
              </th>
              <th className={cn(LB_STICKY_TH_USER, "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                {copy("leaderboard.column.user")}
              </th>
              <th className="px-4 py-4 font-medium text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap">
                {copy("leaderboard.column.total")}
              </th>
              <th className="px-4 py-4 font-medium text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap" title="Based on estimated API pricing, not actual billing">
                Est. Cost
              </th>
              {LEADERBOARD_TOKEN_COLUMNS.map((col) => (
                <th key={col.key} className="px-4 py-4 font-medium text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap">
                  <LeaderboardProviderColumnHeader iconSrc={col.icon} label={copy(col.copyKey)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800/50">
            {displayEntries.map((entry) => {
              const isMe = Boolean(entry?.is_me);
              const profileUserId = typeof entry?.user_id === "string" ? entry.user_id : null;
              const rawName = normalizeName(entry?.display_name);
              const entryName = isAnonymousName(rawName) ? anonLabel : rawName;
              const name = isMe ? meLabel : entryName;
              const userLinkEnabled = Boolean(profileUserId) && !isMe && Boolean(entry?.is_public);
              const publicViewPath = userLinkEnabled
                ? buildPublicViewPath(profileUserId, periodSearch)
                : null;
              const rowClickable = Boolean(publicViewPath);

              if (isMe) {
                return (
                  <tr
                    key={`row-${entry?.rank}-${name}`}
                    className="border-y border-oai-brand-300/40 dark:border-oai-brand-500/30 bg-oai-brand-50 dark:bg-oai-brand-900/10 transition-colors"
                  >
                    <td className={cn(lbStickyTdRank(true), "font-semibold text-oai-brand-600 dark:text-oai-brand-400")}>
                      {entry?.rank ?? placeholder}
                    </td>
                    <td className={lbStickyTdUser(true)}>
                      <div className="flex min-w-0 max-w-[min(320px,55vw)] items-center gap-4">
                        <LeaderboardAvatar
                          avatarUrl={entry?.avatar_url}
                          displayName={name}
                          seed={leaderboardAvatarSeed(entry, name)}
                        />
                        <span className="truncate font-semibold text-oai-black dark:text-oai-white">{name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 font-medium text-oai-black dark:text-oai-white whitespace-nowrap bg-oai-brand-50 dark:bg-oai-brand-900/10">
                      {toDisplayNumber(entry?.total_tokens)}
                    </td>
                    <td className="px-4 py-4 font-medium text-oai-brand-600 dark:text-oai-brand-400 whitespace-nowrap bg-oai-brand-50 dark:bg-oai-brand-900/10" title="Based on estimated API pricing, not actual billing">
                      {formatCost(entry?.estimated_cost_usd)}
                    </td>
                    {leaderboardTokenCells(entry, true)}
                  </tr>
                );
              }

              return (
                <tr
                  key={`row-${entry?.rank}-${name}`}
                  className={cn(
                    "group transition-colors",
                    rowClickable ? "cursor-pointer hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/60" : "",
                  )}
                  onClick={
                    rowClickable
                      ? () => {
                          if (typeof window !== "undefined") {
                            window.location.assign(publicViewPath);
                            return;
                          }
                          navigate(publicViewPath);
                        }
                      : undefined
                  }
                  onKeyDown={
                    rowClickable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (typeof window !== "undefined") {
                              window.location.assign(publicViewPath);
                              return;
                            }
                            navigate(publicViewPath);
                          }
                        }
                      : undefined
                  }
                  role={rowClickable ? "link" : undefined}
                  tabIndex={rowClickable ? 0 : undefined}
                  aria-label={rowClickable ? `Open public dashboard for ${name}` : undefined}
                >
                  <td className={cn(lbStickyTdRank(false), "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                    {entry?.rank ?? placeholder}
                  </td>
                  <td className={lbStickyTdUser(false)}>
                    <div className="flex min-w-0 max-w-[min(320px,55vw)] items-center gap-4">
                      <LeaderboardAvatar
                        avatarUrl={entry?.avatar_url}
                        displayName={name}
                        seed={leaderboardAvatarSeed(entry, name)}
                      />
                      <span className="truncate font-medium text-oai-gray-800 dark:text-oai-gray-200">{name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-oai-gray-700 dark:text-oai-gray-300 whitespace-nowrap bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60">
                    {toDisplayNumber(entry?.total_tokens)}
                  </td>
                  <td className="px-4 py-4 text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60" title="Based on estimated API pricing, not actual billing">
                    {formatCost(entry?.estimated_cost_usd)}
                  </td>
                  {leaderboardTokenCells(entry, false)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  } else {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.empty")}</p>
      </div>
    );
  }

  let pageButtons = null;
  if (typeof totalPages === "number") {
    pageButtons = pageItems.map((p, idx) => {
      if (p == null) {
        return (
          <span
            key={`ellipsis-${idx}`}
            className="px-2 text-oai-gray-400 dark:text-oai-gray-500"
          >
            {copy("leaderboard.pagination.ellipsis")}
          </span>
        );
      }
      return (
        <button
          key={`page-${p}`}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors",
            p === currentPage
              ? "bg-oai-gray-200 dark:bg-oai-gray-800 text-oai-black dark:text-white"
              : "text-oai-gray-500 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
          )}
          onClick={() => setListPage(p)}
          disabled={listState.loading}
        >
          {String(p)}
        </button>
      );
    });
  } else {
    pageButtons = (
      <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("leaderboard.pagination.page_unknown", { page: String(currentPage) })}
      </span>
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
            <ThemeToggle theme={resolvedTheme} onToggle={toggleTheme} />
            <Link
              to={getDashboardEntryPath()}
              className={cn(
                "no-underline inline-flex items-center justify-center h-9 px-5 text-sm font-medium rounded-full transition-colors",
                cloudSignedIn
                  ? "shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 dark:bg-white text-white dark:text-oai-gray-900 hover:bg-oai-gray-800 dark:hover:bg-oai-gray-100"
                  : "ring-1 ring-oai-gray-200 dark:ring-oai-gray-700 text-oai-gray-600 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800",
              )}
            >
              {copy("landing.v2.cta.primary")}
            </Link>
            <InsforgeUserHeaderControls />
          </div>
        </div>
      </header>

      <main className="flex-1 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
            <div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("leaderboard.title")}
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

            <div className="flex items-center gap-3">
              {authTokenAllowed && authTokenReady && (
                <button
                  onClick={handleRefresh}
                  disabled={refreshing || listState.loading}
                  className="text-sm text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white transition-colors disabled:opacity-50"
                >
                  {refreshing ? "Refreshing..." : "\u21BB"}
                </button>
              )}
              <div className="inline-flex p-1 border border-oai-gray-200 dark:border-oai-gray-800 rounded-lg">
                {["week", "month", "total"].map((p) => (
                  <button
                    key={p}
                    onClick={() => handlePeriodChange(p)}
                    disabled={listState.loading}
                    className={cn(
                      "px-4 py-1.5 text-sm font-medium rounded-md transition-colors",
                      period === p
                        ? "bg-oai-gray-200 dark:bg-oai-gray-800 text-oai-black dark:text-white"
                        : "text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-800 dark:hover:text-oai-gray-200"
                    )}
                  >
                    {p === "week" ? weekLabel : p === "month" ? monthLabel : totalLabel}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!signedIn && (
            <div className="mb-6 flex items-center justify-between text-sm">
              <p className="text-oai-gray-500 dark:text-oai-gray-400">Sign in to join the leaderboard</p>
              <button
                onClick={openLoginModal}
                className="px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 transition-colors"
              >
                Sign In
              </button>
            </div>
          )}

          {authTokenAllowed && authTokenReady && !cloudSyncOn && (
            <div className="mb-6 flex items-center justify-between text-sm">
              <p className="text-oai-gray-500 dark:text-oai-gray-400">Enable Cloud Sync to appear in rankings</p>
              <button
                onClick={handleEnableSync}
                disabled={syncing}
                className="px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 disabled:opacity-50 transition-colors"
              >
                {syncing ? "Syncing..." : "Enable & Sync"}
              </button>
            </div>
          )}

          <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 overflow-hidden">
            {listBody}

            <div className="px-6 py-3 border-t border-oai-gray-200 dark:border-oai-gray-800 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium text-oai-gray-500 dark:text-oai-gray-400 rounded-md transition-colors",
                    canPrev && !listState.loading
                      ? "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
                      : "opacity-50 cursor-not-allowed"
                  )}
                  onClick={() => setListPage((p) => Math.max(1, p - 1))}
                  disabled={!canPrev || listState.loading}
                >
                  {copy("leaderboard.pagination.prev")}
                </button>
                <button
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium text-oai-gray-500 dark:text-oai-gray-400 rounded-md transition-colors",
                    canNext && !listState.loading
                      ? "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white"
                      : "opacity-50 cursor-not-allowed"
                  )}
                  onClick={() => setListPage((p) => p + 1)}
                  disabled={!canNext || listState.loading}
                >
                  {copy("leaderboard.pagination.next")}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1">{pageButtons}</div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-oai-gray-200 dark:border-oai-gray-900 py-8 transition-colors duration-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 text-sm text-oai-gray-400 dark:text-oai-gray-500">
          <p>{copy("landing.v2.footer.line")}</p>
          <a
            href="https://github.com/mm7894215/tokentracker"
            className="text-oai-gray-400 dark:text-oai-gray-500 hover:text-oai-black dark:hover:text-white transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy("landing.v2.nav.github")}
          </a>
        </div>
      </footer>
    </div>
  );
}
