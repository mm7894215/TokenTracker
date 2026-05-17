import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
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
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
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

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_STORAGE_KEY = "tokentracker:leaderboard:pageSize";

function readStoredPageSize() {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    const n = Number(raw);
    if (PAGE_SIZE_OPTIONS.includes(n)) return n;
  } catch {
    // ignore storage errors (private mode, disabled, etc.)
  }
  return DEFAULT_PAGE_SIZE;
}

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

/**
 * Small GitHub icon that expands into a tooltip on hover. The tooltip carries a
 * clickable "Settings" link so users who haven't configured their own GitHub yet
 * know where to turn it on. Uses a named Tailwind group (`group/gh`) so hover
 * state is scoped to this span — leaderboard rows already have their own
 * `group` for row-hover backgrounds and we don't want to collide.
 */
function GithubLinkWithTooltip({ githubUrl }) {
  return (
    <span className="relative inline-flex items-center group/gh shrink-0">
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label={copy("leaderboard.github.aria")}
        className="text-oai-black hover:text-oai-gray-500 dark:text-white dark:hover:text-oai-gray-400 transition-colors"
      >
        <ProviderIcon provider="GITHUB" size={16} />
      </a>
      <span
        role="tooltip"
        // Render above the icon so the next row's sticky <td> can't cover the
        // tooltip (later rows paint higher in the stacking order). left-0 keeps
        // it inside the user column.
        //
        // CRITICAL for hover persistence:
        //  1. NO margin between tooltip and icon. A margin is dead space — the
        //     cursor leaves the group bounding box while traveling across it,
        //     hover breaks, tooltip disappears mid-motion.
        //  2. NO pointer-events-none on the tooltip. It's a descendant of the
        //     group; :hover must reach it for group-hover to stay true.
        //  3. ::before bridge extends the tooltip's hit-area down to the
        //     icon's top edge so the cursor's path from icon up into the
        //     tooltip text stays inside the group the whole time.
        // right-0 so the tooltip grows leftward from the icon (icon now sits
        // on the right side of the cell after the name). mb-2 gives an 8px
        // visual gap; ::before h-2.5 (10px) bridges it for hit-testing so the
        // cursor never leaves the group while moving from icon into tooltip.
        className="invisible opacity-0 group-hover/gh:visible group-hover/gh:opacity-100 absolute right-0 bottom-full mb-2 whitespace-nowrap rounded-md bg-oai-black dark:bg-oai-gray-700 px-2.5 py-1.5 text-[11px] leading-relaxed text-white shadow-lg transition-opacity duration-150 z-50 before:content-[''] before:absolute before:inset-x-0 before:top-full before:h-2.5"
      >
        <span className="block">{copy("leaderboard.github.tooltipAction")}</span>
        <span className="block text-oai-gray-300 dark:text-oai-gray-400">
          {copy("leaderboard.github.tooltipPrefix")}{" "}
          <Link
            to="/settings"
            onClick={(e) => e.stopPropagation()}
            className="text-white underline underline-offset-2 decoration-oai-gray-400 hover:text-oai-brand-300 hover:decoration-oai-brand-300"
          >
            {copy("leaderboard.github.tooltipSettingsLink")}
          </Link>
          {copy("leaderboard.github.tooltipSuffix")}
        </span>
      </span>
    </span>
  );
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
  const [pageSize, setPageSizeState] = useState(readStoredPageSize);

  const setPageSize = useCallback((next) => {
    const normalized = PAGE_SIZE_OPTIONS.includes(next) ? next : DEFAULT_PAGE_SIZE;
    setPageSizeState(normalized);
    setListPage(1);
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(normalized));
    } catch {
      // ignore
    }
  }, []);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [listState, setListState] = useState(() => ({
    loading: false,
    error: null,
    data: null,
  }));

  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [syncing, setSyncing] = useState(false);

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
    return (safePage - 1) * pageSize;
  }, [listPage, pageSize]);

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
        limit: pageSize,
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
    pageSize,
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
      limit: pageSize,
    });
  }, [currentPage, listData?.entries, me, meLabel, pageSize]);

  const handleEnableSync = async () => {
    setSyncing(true);
    try {
      setCloudSyncEnabled(true);
      setCloudSyncOn(true);
      await runCloudUsageSyncNow(() => resolveAuthAccessTokenWithRetry(effectiveAuthToken));
      const token = await resolveAuthAccessTokenWithRetry(effectiveAuthToken);
      if (token) await refreshLeaderboard({ accessToken: token, period, source: "leaderboard-enable-sync" });
      setListReloadToken((v) => v + 1);
    } catch (e) {
      console.warn("[tokentracker] sync:", e);
    } finally {
      setSyncing(false);
    }
  };

  const { canPrev, canNext } = getPaginationFlags({ page: currentPage, totalPages });

  const hasEntries = Array.isArray(displayEntries) && displayEntries.length !== 0;
  let listBody = null;
  if (listState.loading) {
    listBody = <LeaderboardSkeleton rows={pageSize} />;
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
                {copy("leaderboard.column.est_cost")}
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
            {displayEntries.map((entry, entryIdx) => {
              if (entry?.is_ellipsis) {
                const colSpan = 4 + orderedColumns.length;
                return (
                  <tr key={`ellipsis-${entryIdx}`} aria-hidden="true">
                    <td
                      colSpan={colSpan}
                      className="px-4 py-2 text-center text-oai-gray-400 dark:text-oai-gray-600 bg-white dark:bg-oai-gray-950 select-none tracking-[0.4em] text-xs"
                    >
                      ···
                    </td>
                  </tr>
                );
              }
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
                      <div className="flex min-w-0 items-center gap-2">
                        <LeaderboardAvatar
                          avatarUrl={entry?.avatar_url}
                          displayName={name}
                          seed={leaderboardAvatarSeed(entry, name)}
                        />
                        <span className="truncate font-semibold text-oai-black dark:text-oai-white">{name}</span>
                        {entry?.github_url && <GithubLinkWithTooltip githubUrl={entry.github_url} />}
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
                    <div className="flex min-w-0 items-center gap-2">
                      <LeaderboardAvatar
                        avatarUrl={entry?.avatar_url}
                        displayName={name}
                        seed={leaderboardAvatarSeed(entry, name)}
                      />
                      <span className="truncate font-medium text-oai-gray-800 dark:text-oai-gray-200">{name}</span>
                      {entry?.github_url && <GithubLinkWithTooltip githubUrl={entry.github_url} />}
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
              <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.signin_prompt")}</p>
              <button
                onClick={openLoginModal}
                className="px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 transition-colors"
              >
                {copy("leaderboard.signin_button")}
              </button>
            </div>
          )}

          {authTokenAllowed && authTokenReady && !cloudSyncOn && (
            <div className="mb-6 flex items-center justify-between text-sm">
              <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.sync_prompt")}</p>
              <button
                onClick={handleEnableSync}
                disabled={syncing}
                className="px-3 py-1.5 text-sm font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md hover:text-oai-black dark:hover:text-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600 disabled:opacity-50 transition-colors"
              >
                {syncing ? copy("leaderboard.sync_button.busy") : copy("leaderboard.sync_button.idle")}
              </button>
            </div>
          )}

          <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 overflow-hidden">
            {listBody}

            <div className="px-6 py-3 border-t border-oai-gray-200 dark:border-oai-gray-800 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <div className="flex items-center gap-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                <label htmlFor="leaderboard-page-size" className="whitespace-nowrap">
                  {copy("leaderboard.pagination.page_size_label")}
                </label>
                <div className="relative">
                  <select
                    id="leaderboard-page-size"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    disabled={listState.loading}
                    className="appearance-none pl-3 pr-8 py-1 rounded-md bg-white dark:bg-oai-gray-950 border border-oai-gray-300 dark:border-oai-gray-700 text-oai-gray-700 dark:text-oai-gray-300 hover:border-oai-gray-400 dark:hover:border-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500 disabled:opacity-50 transition-colors"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-oai-gray-500 dark:text-oai-gray-400"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </div>
              </div>
              <div className="h-5 w-px bg-oai-gray-200 dark:bg-oai-gray-800" aria-hidden="true" />
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
              <div className="flex flex-wrap items-center gap-1">{pageButtons}</div>
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
