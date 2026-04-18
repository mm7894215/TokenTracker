import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
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
import { LeaderboardAvatar } from "../components/LeaderboardAvatar.jsx";
import { LeaderboardProviderColumnHeader } from "../components/LeaderboardProviderColumnHeader.jsx";
import { LeaderboardSkeleton } from "../components/LeaderboardSkeleton.jsx";
import { SortableColumnHeader } from "../components/SortableColumnHeader.jsx";
import { useColumnOrder } from "../hooks/use-column-order.js";
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

function leaderboardTokenCells(entry, isMe, orderedColumns) {
  const numCls = isMe
    ? "text-oai-gray-700 dark:text-oai-gray-300"
    : "text-oai-gray-500 dark:text-oai-gray-400";
  const cellBg = isMe
    ? "bg-oai-brand-50 dark:bg-oai-brand-900/10"
    : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60";
  return orderedColumns.map((col) => (
    <td
      key={col.key}
      data-column-key={col.key}
      className={cn("px-4 py-4 whitespace-nowrap text-right tabular-nums", numCls, cellBg)}
    >
      {toDisplayNumber(entry?.[col.key])}
    </td>
  ));
}

const RANK_MEDAL = {
  1: { text: "text-amber-600 dark:text-amber-400", badge: "bg-amber-50 dark:bg-amber-900/20" },
  2: { text: "text-gray-500 dark:text-gray-300", badge: "bg-gray-50 dark:bg-gray-800/40" },
  3: { text: "text-orange-700 dark:text-orange-400", badge: "bg-orange-50 dark:bg-orange-900/20" },
};

function RankCell({ rank, placeholder }) {
  const medal = RANK_MEDAL[rank];
  if (medal) {
    return (
      <span className={cn("inline-flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold", medal.text, medal.badge)}>
        {rank}
      </span>
    );
  }
  return <span className="inline-flex items-center justify-center h-7 w-7 text-sm">{rank ?? placeholder}</span>;
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
  const { signedIn: cloudSignedIn, loading: authLoading, user: cloudUser } = useInsforgeAuth();
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

  const defaultColumnKeys = useMemo(
    () => LEADERBOARD_TOKEN_COLUMNS.map((c) => c.key),
    [],
  );
  const { order: columnOrder, reorder: reorderColumns } = useColumnOrder(defaultColumnKeys);
  const columnsByKey = useMemo(() => {
    const map = new Map();
    for (const c of LEADERBOARD_TOKEN_COLUMNS) map.set(c.key, c);
    return map;
  }, []);
  const orderedColumns = useMemo(
    () => columnOrder.map((k) => columnsByKey.get(k)).filter(Boolean),
    [columnOrder, columnsByKey],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderColumns(String(active.id), String(over.id));
    },
    [reorderColumns],
  );

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
    return normalizePeriod(params.get("period")) || "total";
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

  const listOffset = useMemo(() => {
    const safePage = clampInt(listPage, { min: 1, max: 1_000_000, fallback: 1 });
    return (safePage - 1) * PAGE_LIMIT;
  }, [listPage]);

  useEffect(() => {
    // Mock leaderboard uses local getMockLeaderboard(); real data needs InsForge URL from getLeaderboardBaseUrl().
    if (!leaderboardBaseUrl && !mockEnabled) return;
    let active = true;
    setListState((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      const data = await getLeaderboard({
        baseUrl: leaderboardBaseUrl,
        userId: cloudUser?.id || null,
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
    cloudUser?.id,
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
    listBody = <LeaderboardSkeleton rows={PAGE_LIMIT} />;
  } else if (listState.error) {
    listBody = (
      <div className="px-6 py-12 text-center">
        <p className="text-sm text-red-500 dark:text-red-400">{listState.error}</p>
      </div>
    );
  } else if (hasEntries) {
    listBody = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
      >
      <div className="w-full overflow-x-auto">
        <table className="min-w-max w-full text-left text-sm">
          <thead className="border-b border-oai-gray-200 dark:border-oai-gray-800">
            <tr>
              <th className={cn(LB_STICKY_TH_RANK, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.rank")}
              </th>
              <th className={cn(LB_STICKY_TH_USER, "text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500")}>
                {copy("leaderboard.column.user")}
              </th>
              <th className="px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap text-right align-middle">
                {copy("leaderboard.column.total")}
              </th>
              <th className="px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap text-right align-middle" title="Based on estimated API pricing, not actual billing">
                Est. Cost
              </th>
              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                {orderedColumns.map((col) => (
                  <SortableColumnHeader
                    key={col.key}
                    id={col.key}
                    thClassName="px-4 py-4 text-[11px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap align-middle"
                  >
                    <LeaderboardProviderColumnHeader iconSrc={col.icon} label={copy(col.copyKey)} />
                  </SortableColumnHeader>
                ))}
              </SortableContext>
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
                      <RankCell rank={entry?.rank} placeholder={placeholder} />
                    </td>
                    <td className={lbStickyTdUser(true)}>
                      <div className="flex min-w-0 max-w-[min(160px,40vw)] items-center gap-4">
                        <LeaderboardAvatar
                          avatarUrl={entry?.avatar_url}
                          displayName={name}
                          seed={leaderboardAvatarSeed(entry, name)}
                        />
                        <span className="truncate font-semibold text-oai-black dark:text-oai-white">{name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 font-medium text-oai-black dark:text-oai-white whitespace-nowrap text-right tabular-nums bg-oai-brand-50 dark:bg-oai-brand-900/10">
                      {toDisplayNumber(entry?.total_tokens)}
                    </td>
                    <td className="px-4 py-4 font-medium text-oai-brand-600 dark:text-oai-brand-400 whitespace-nowrap text-right tabular-nums bg-oai-brand-50 dark:bg-oai-brand-900/10" title="Based on estimated API pricing, not actual billing">
                      {formatCost(entry?.estimated_cost_usd)}
                    </td>
                    {leaderboardTokenCells(entry, true, orderedColumns)}
                  </tr>
                );
              }

              return (
                <tr
                  key={`row-${entry?.rank}-${name}`}
                  className="group transition-colors"
                >
                  <td className={cn(lbStickyTdRank(false), "font-medium text-oai-gray-500 dark:text-oai-gray-400")}>
                    <RankCell rank={entry?.rank} placeholder={placeholder} />
                  </td>
                  <td className={lbStickyTdUser(false)}>
                    <div className="flex min-w-0 max-w-[min(160px,40vw)] items-center gap-4">
                      <LeaderboardAvatar
                        avatarUrl={entry?.avatar_url}
                        displayName={name}
                        seed={leaderboardAvatarSeed(entry, name)}
                      />
                      <span className="truncate font-medium text-oai-gray-800 dark:text-oai-gray-200">{name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 font-semibold text-oai-gray-800 dark:text-oai-gray-200 whitespace-nowrap text-right tabular-nums bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60">
                    {toDisplayNumber(entry?.total_tokens)}
                  </td>
                  <td className="px-4 py-4 text-oai-gray-500 dark:text-oai-gray-400 whitespace-nowrap text-right tabular-nums bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900/60" title="Based on estimated API pricing, not actual billing">
                    {formatCost(entry?.estimated_cost_usd)}
                  </td>
                  {leaderboardTokenCells(entry, false, orderedColumns)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </DndContext>
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
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
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

            <div className="flex items-center gap-2">
              {authTokenAllowed && authTokenReady && (
                <div className="inline-flex p-1 border border-oai-gray-200 dark:border-oai-gray-800 rounded-lg">
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing || listState.loading}
                    className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-900 hover:text-oai-black dark:hover:text-white disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <svg
                      className={cn("w-4 h-4", refreshing && "animate-spin")}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 12a9 9 0 0 1 15.5-6.5L21 8" />
                      <path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-15.5 6.5L3 16" />
                      <path d="M3 21v-5h5" />
                    </svg>
                    {refreshing ? "Refreshing" : "Refresh"}
                  </button>
                </div>
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
            href="https://github.com/mm7894215/TokenTracker"
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
