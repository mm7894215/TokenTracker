import { useEffect, useState } from "react";
import { getLeaderboard } from "../../lib/api";
import { isMockEnabled } from "../../lib/mock-data";
import type { ShareRankPeriod } from "./share-card-options";

type UseShareRankParams = {
  enabled: boolean;
  fallbackRank: number | null;
  getAccessToken?: () => Promise<string | null>;
  period: ShareRankPeriod;
  user: any;
};

function pickUserId(user: any): string | null {
  const value = user?.id ?? user?.user_id ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pickMyRank(payload: any): number | null {
  const entries = Array.isArray(payload?.entries)
    ? payload.entries
    : Array.isArray(payload)
      ? payload
      : [];
  const mine = entries.find((entry: any) => entry?.is_me === true);
  return typeof mine?.rank === "number" ? mine.rank : null;
}

export function useShareRank(params: UseShareRankParams): number | null {
  const { enabled, fallbackRank, getAccessToken, period, user } = params;
  const [rank, setRank] = useState<number | null>(fallbackRank);

  useEffect(() => {
    const fallback = period === "total" ? fallbackRank : null;
    if (!enabled) {
      setRank(fallback);
      return;
    }

    const userId = pickUserId(user);
    if (!userId && !isMockEnabled()) {
      setRank(fallback);
      return;
    }

    let cancelled = false;
    setRank(fallback);

    (async () => {
      try {
        const accessToken = getAccessToken ? await getAccessToken() : null;
        const payload = await getLeaderboard({
          accessToken,
          userId,
          period,
          metric: "all",
          limit: 100,
          offset: 0,
        } as any);
        if (!cancelled) setRank(pickMyRank(payload));
      } catch (error) {
        console.warn("[share] rank fetch failed", error);
        if (!cancelled) setRank(fallback);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, fallbackRank, getAccessToken, period, user]);

  return rank;
}
