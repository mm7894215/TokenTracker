import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useAchievements } from "../hooks/use-achievements.js";
import { getUserBadges } from "../lib/api";
import { copy } from "../lib/copy";
import { isMockEnabled } from "../lib/mock-data";
import { AchievementsSection } from "../ui/achievements/AchievementsSection.jsx";
import { BADGE_CATALOG } from "../ui/achievements/badge-catalog.js";

// Lazy: 3D coin + dialog ship only when a badge is clicked.
const BadgeDetailModal = React.lazy(() => import("../ui/achievements/BadgeDetailModal.jsx"));

export function resolveCloudBadgeIdentity({ authLoading, authEnabled, authUserId, mockEnabled }) {
  if (mockEnabled) {
    return { authLoading: false, signedIn: true, userId: "mock-user" };
  }
  const signedIn = Boolean(authEnabled && authUserId);
  return {
    authLoading: Boolean(authLoading),
    signedIn,
    userId: signedIn ? authUserId : null,
  };
}

/** Cloud badges for the signed-in user via their own profile payload. */
function useOwnCloudBadges() {
  const auth = useInsforgeAuth();
  const [state, setState] = useState({ status: "loading", achievements: [], userId: null });
  const mockEnabled = isMockEnabled();
  const { authLoading, signedIn, userId } = resolveCloudBadgeIdentity({
    authLoading: auth?.loading,
    authEnabled: auth?.enabled,
    authUserId: auth?.user?.id,
    mockEnabled,
  });

  useEffect(() => {
    if (authLoading) {
      setState({ status: "loading", achievements: [], userId: null });
      return undefined;
    }
    if (!signedIn) {
      setState({ status: "signed-out", achievements: [], userId: null });
      return undefined;
    }
    let cancelled = false;
    // Auth can hydrate after the local endpoint has already resolved. Reset
    // synchronously for this user and keep the merged wall behind its skeleton
    // until the cloud request settles, otherwise the three local badges flash
    // first and the whole wall recolors/reorders a moment later.
    setState({ status: "loading", achievements: [], userId });
    (async () => {
      try {
        const accessToken = mockEnabled ? null : await auth.getAccessToken?.();
        const data = await getUserBadges({
          accessToken,
          userId,
        });
        if (cancelled) return;
        setState({
          status: "ready",
          achievements: Array.isArray(data?.badges) ? data.badges : [],
          userId,
        });
      } catch {
        if (!cancelled) setState({ status: "error", achievements: [], userId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, mockEnabled, signedIn, userId]);

  return {
    ...state,
    signedIn,
    settled: cloudBadgesSettled({ authLoading, signedIn, userId, state }),
  };
}

export function cloudBadgesSettled({ authLoading, signedIn, userId, state }) {
  if (authLoading) return false;
  if (!signedIn) return state.status === "signed-out";
  return state.userId === userId && (state.status === "ready" || state.status === "error");
}

function GridSkeleton() {
  // Mirrors AchievementsSection's wide layout 1:1 so content pops in with
  // zero shift.
  return (
    <div
      className="mx-0 grid animate-pulse grid-cols-[repeat(3,max-content)] justify-between gap-y-7 sm:-mx-2 sm:grid-cols-[repeat(4,max-content)] lg:grid-cols-[repeat(5,max-content)]"
      aria-hidden
    >
      {Array.from({ length: BADGE_CATALOG.length }).map((_, index) => (
        <div key={index} className="flex w-[6.75rem] flex-col items-center px-0 pb-3 pt-4 sm:w-[7.75rem]">
          <div className="h-[108px] w-[108px] rounded-full bg-oai-gray-200 dark:bg-oai-gray-800" />
          <div className="mt-3 h-3 w-16 rounded bg-oai-gray-200 dark:bg-oai-gray-800" />
          <div className="mt-2 h-2 w-10 rounded bg-oai-gray-100 dark:bg-oai-gray-800/60" />
        </div>
      ))}
    </div>
  );
}

export default function AchievementsPage() {
  const local = useAchievements();
  const cloud = useOwnCloudBadges();
  const [selectedBadge, setSelectedBadge] = useState(null);
  const loading = local.status === "loading" || !cloud.settled;

  // One merged wall — users think in badges, not in where a badge is
  // computed. Cloud and local records never share ids, so a flat concat is a
  // clean merge; the grid orders earned first, locked tail after.
  const merged = useMemo(
    () => [...(cloud.achievements || []), ...(local.achievements || [])],
    [cloud.achievements, local.achievements],
  );
  const earnedCount = useMemo(
    () => merged.filter((b) => (b?.tier || 0) >= 1).length,
    [merged],
  );
  const total = BADGE_CATALOG.length;

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          {/* items-baseline: the 12/12 figure sits on the SAME baseline as
              the page title — the two big text elements read as one line. */}
          <div className="mb-7 flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                {copy("achievements.page.title")}
              </h1>
              <p className="mt-1.5 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {copy("achievements.page.local_note")}
              </p>
            </div>
            {!loading && (
              <div className="shrink-0 text-right">
                <div className="font-mono text-2xl font-semibold leading-none tabular-nums text-oai-black dark:text-white">
                  {earnedCount}
                  <span className="text-oai-gray-400 dark:text-oai-gray-600">/{total}</span>
                </div>
                <div className="mt-2 h-1 w-24 overflow-hidden rounded-full bg-oai-gray-200 dark:bg-oai-gray-800">
                  <div
                    className="h-full rounded-full bg-oai-brand-600 transition-[width] duration-500"
                    style={{ width: `${Math.round((earnedCount / total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {!cloud.signedIn && !loading && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-oai-gray-200 bg-oai-gray-50 px-4 py-3 dark:border-oai-gray-800 dark:bg-oai-gray-900/60">
              <p className="text-sm text-oai-gray-600 dark:text-oai-gray-300">
                {copy("achievements.signin.prompt")}
              </p>
              <Link
                to="/login"
                className="shrink-0 rounded-lg bg-oai-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-oai-brand-700 active:scale-[0.98]"
              >
                {copy("achievements.signin.action")}
              </Link>
            </div>
          )}

          {loading ? (
            <GridSkeleton />
          ) : (
            <>
              <AchievementsSection
                achievements={merged}
                isOwn
                columns="wide"
                size="lg"
                animateIn
                onSelect={setSelectedBadge}
              />
              <p className="mt-10 text-center text-xs text-oai-gray-400 dark:text-oai-gray-500">
                {copy("achievements.page.suggest")}{" "}
                <a
                  href="https://github.com/xiufengsun/TokenTracker/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-oai-gray-300 underline-offset-2 transition-colors hover:text-oai-gray-700 hover:decoration-oai-gray-500 dark:decoration-oai-gray-600 dark:hover:text-oai-gray-300"
                >
                  {copy("achievements.page.suggest_link")}
                </a>
              </p>
            </>
          )}
        </div>
      </main>

      {selectedBadge && (
        <React.Suspense fallback={null}>
          <BadgeDetailModal badge={selectedBadge} onClose={() => setSelectedBadge(null)} />
        </React.Suspense>
      )}
    </div>
  );
}
