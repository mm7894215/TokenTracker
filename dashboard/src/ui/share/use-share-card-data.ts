import { useEffect, useMemo, useState } from "react";
import { getLeaderboard } from "../../lib/api";
import { isMockEnabled } from "../../lib/mock-data";
import {
  buildShareCardData,
  type ShareCardData,
  type ShareCardModel,
  type ShareCardPeriod,
} from "./build-share-card-data";
import { defaultShareVisibleStats } from "./share-card-options";

interface UseShareCardDataParams {
  enabled: boolean;
  handle: string;
  startDate: string | null;
  activeDays: number;
  summary: any;
  topModels: ShareCardModel[] | null | undefined;
  period: ShareCardPeriod;
  periodFrom: string | null;
  periodTo: string | null;
  heatmap: any;
  accessToken: string | null;
  userId: string | null;
}

export function useShareCardData(params: UseShareCardDataParams): ShareCardData {
  const {
    enabled,
    handle,
    startDate,
    activeDays,
    summary,
    topModels,
    period,
    periodFrom,
    periodTo,
    heatmap,
    accessToken,
    userId,
  } = params;

  const [rank, setRank] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!userId && !isMockEnabled()) return;
    let cancelled = false;
    (async () => {
      try {
        const leaderboardPeriod = period === "day" || period === "custom" ? "week" : period;
        const payload = await getLeaderboard({
          accessToken,
          userId,
          period: leaderboardPeriod,
          metric: "all",
          limit: 100,
          offset: 0,
        } as any);
        if (cancelled) return;
        const entries = Array.isArray((payload as any)?.entries)
          ? (payload as any).entries
          : Array.isArray(payload)
            ? payload
            : [];
        const mine = entries.find((entry: any) => entry?.is_me === true);
        const r = typeof mine?.rank === "number" ? mine.rank : null;
        setRank(r);
      } catch {
        if (!cancelled) setRank(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, accessToken, userId, period]);

  return useMemo(
    () =>
      buildShareCardData({
        handle,
        startDate,
        activeDays,
        summary,
        topModels,
        rank,
        rankPeriod: "total",
        visibleStats: defaultShareVisibleStats({ rankEnabled: rank != null }),
        period,
        periodFrom,
        periodTo,
        heatmap,
      }),
    [
      handle,
      startDate,
      activeDays,
      summary,
      topModels,
      rank,
      period,
      periodFrom,
      periodTo,
      heatmap,
    ],
  );
}
