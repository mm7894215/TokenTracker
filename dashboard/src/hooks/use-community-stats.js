import { useEffect, useState } from "react";
import { getLeaderboard, getCommunityModels } from "../lib/api";

const FETCH_TIMEOUT_MS = 6000;
const MODEL_FETCH_TIMEOUT_MS = 2500;
// One page of 100 gives a strong lower bound on the global total without a
// dedicated stats endpoint (the leaderboard is heavily top-weighted).
const SAMPLE_LIMIT = 100;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("landing stats timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId != null) clearTimeout(timeoutId);
  });
}

// The stats are global and slow-moving, but the hook mounts on both the
// landing page and the leaderboard — share one in-flight/recent fetch so an
// SPA navigation between them doesn't refire the identical request pair.
const CACHE_TTL_MS = 5 * 60_000;
const PERSISTED_MAX_AGE_MS = 24 * 60 * 60_000;
export const COMMUNITY_STATS_STORAGE_KEY = "tokentracker:community-stats:v2";
let cachedFetch = null;

function normalizeCachedData(value) {
  const tokenFloor = Number(value?.tokenFloor) || 0;
  const totalEntries = Number(value?.totalEntries) || 0;
  if (!(tokenFloor > 0) || !(totalEntries > 0)) return null;
  return {
    tokenFloor,
    totalEntries,
    top: Array.isArray(value?.top) ? value.top : [],
    topModels: Array.isArray(value?.topModels) ? value.topModels : [],
    providers: Array.isArray(value?.providers) ? value.providers : [],
    dailyGrowth: Array.isArray(value?.dailyGrowth) ? value.dailyGrowth : [],
    tokenMix: Array.isArray(value?.tokenMix) ? value.tokenMix : [],
    userDistribution: Array.isArray(value?.userDistribution) ? value.userDistribution : [],
    platforms: Array.isArray(value?.platforms) ? value.platforms : [],
    activeDevelopersTotal: Number(value?.activeDevelopersTotal) || 0,
    activeDevelopers30d: Number(value?.activeDevelopers30d) || 0,
    tokens30d: Number(value?.tokens30d) || 0,
    tokenGrowthPct: value?.tokenGrowthPct != null
      && Number.isFinite(Number(value.tokenGrowthPct))
      ? Number(value.tokenGrowthPct)
      : null,
    developerGrowthPct: value?.developerGrowthPct != null
      && Number.isFinite(Number(value.developerGrowthPct))
      ? Number(value.developerGrowthPct)
      : null,
    generatedAt: typeof value?.generatedAt === "string" ? value.generatedAt : null,
  };
}

function readPersistentCache() {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMMUNITY_STATS_STORAGE_KEY) || "null");
    const cachedAt = Number(parsed?.cachedAt) || 0;
    const data = normalizeCachedData(parsed?.data);
    const age = Date.now() - cachedAt;
    if (!data || age < 0 || age > PERSISTED_MAX_AGE_MS) return null;
    return { data, isFresh: age < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function writePersistentCache(data) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(COMMUNITY_STATS_STORAGE_KEY, JSON.stringify({
      cachedAt: Date.now(),
      data,
    }));
  } catch {
    // Storage can be unavailable in private mode or at quota; memory state is
    // still enough for the current page.
  }
}

function fetchCommunityData() {
  if (cachedFetch && Date.now() - cachedFetch.at < CACHE_TTL_MS) {
    return cachedFetch.promise;
  }
  const promise = Promise.all([
    withTimeout(
      getLeaderboard({ period: "total", limit: SAMPLE_LIMIT, offset: 0 }),
      FETCH_TIMEOUT_MS,
    ),
    withTimeout(getCommunityModels(), MODEL_FETCH_TIMEOUT_MS).catch(() => null),
  ]);
  cachedFetch = { at: Date.now(), promise };
  // Never cache a failure: the next consumer should retry.
  promise.catch(() => {
    if (cachedFetch?.promise === promise) cachedFetch = null;
  });
  return promise;
}

export function resetCommunityStatsCacheForTests() {
  cachedFetch = null;
}

/**
 * Fetches the public leaderboard once (idle-time, anonymous) and derives the
 * community's live numbers: a floor for total tokens synced, the number of
 * syncing developers, and the top-3 podium slice. Also fetches real
 * model-level token breakdown from the community-models endpoint.
 * Never throws: cached data stays visible through transient failures; only an
 * uncached leaderboard failure becomes "error" and falls back to static copy.
 */
export function useCommunityStats({ enabled = true } = {}) {
  const [persistentCache] = useState(() => readPersistentCache());
  const [state, setState] = useState(() => persistentCache
    ? { status: "ready", ...persistentCache.data }
    : {
        status: "loading",
        tokenFloor: null,
        totalEntries: null,
        top: [],
      });

  useEffect(() => {
    if (!enabled) return undefined;
    if (persistentCache?.isFresh) return undefined;
    let cancelled = false;
    let idleId = null;
    let timerId = null;

    const run = async () => {
      try {
        // Fetch leaderboard + model breakdown in parallel.
        // Model breakdown is best-effort: if it fails we still show
        // provider-level data from the snapshot.
        const [data, modelsData] = await fetchCommunityData();
        if (cancelled) return;
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        const sampledTokenFloor = entries.reduce(
          (sum, entry) => sum + (Number(entry?.total_tokens) || 0),
          0,
        );
        const communityTotalTokens = Number(modelsData?.total_tokens) || 0;
        if (!(communityTotalTokens > 0)) {
          // The leaderboard sum is only a lower-bound fallback. Do not let a
          // successful lightweight request make a failed authoritative model
          // request look fresh to the next consumer.
          cachedFetch = null;
        }
        const cachedTokenFloor = Number(persistentCache?.data?.tokenFloor) || 0;
        const tokenFloor = communityTotalTokens > 0
          ? communityTotalTokens
          : (cachedTokenFloor > 0 ? cachedTokenFloor : sampledTokenFloor);
        if (!entries.length || !(tokenFloor > 0)) {
          setState((prev) => ({ ...prev, status: "error" }));
          return;
        }

        // Real model-level breakdown from the dedicated endpoint
        const topModels = Array.isArray(modelsData?.top_models)
          ? modelsData.top_models
          : (persistentCache?.data?.topModels || []);

        const readyData = {
          tokenFloor,
          totalEntries: Number(data?.total_entries) || entries.length,
          top: entries.slice(0, 3),
          topModels,
          providers: Array.isArray(modelsData?.providers) ? modelsData.providers : [],
          dailyGrowth: Array.isArray(modelsData?.daily_growth) ? modelsData.daily_growth : [],
          tokenMix: Array.isArray(modelsData?.token_mix) ? modelsData.token_mix : [],
          userDistribution: Array.isArray(modelsData?.user_distribution)
            ? modelsData.user_distribution
            : [],
          platforms: Array.isArray(modelsData?.platforms) ? modelsData.platforms : [],
          activeDevelopersTotal: Number(modelsData?.active_developers_total) || 0,
          activeDevelopers30d: Number(modelsData?.active_developers_30d) || 0,
          tokens30d: Number(modelsData?.tokens_30d) || 0,
          tokenGrowthPct: modelsData?.token_growth_pct == null
            ? null
            : Number(modelsData.token_growth_pct),
          developerGrowthPct: modelsData?.developer_growth_pct == null
            ? null
            : Number(modelsData.developer_growth_pct),
          generatedAt: typeof modelsData?.generated_at === "string"
            ? modelsData.generated_at
            : null,
        };
        setState({ status: "ready", ...readyData });
        // Do not make an old authoritative total look fresh when only the
        // lightweight leaderboard request recovered. Keeping the old storage
        // timestamp makes the next mount retry model revalidation.
        if (communityTotalTokens > 0) {
          writePersistentCache(readyData);
        }
      } catch (_e) {
        // Keep the last successful snapshot visible during transient backend
        // failures. Only first-time visitors with no cache fall back to copy.
        if (!cancelled) {
          setState((prev) => prev.status === "ready"
            ? prev
            : { ...prev, status: "error" });
        }
      }
    };

    // Idle-time so the fetch never competes with first paint / LCP.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      timerId = setTimeout(run, 400);
    }

    return () => {
      cancelled = true;
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (timerId != null) clearTimeout(timerId);
    };
  }, [enabled, persistentCache]);

  return state;
}
