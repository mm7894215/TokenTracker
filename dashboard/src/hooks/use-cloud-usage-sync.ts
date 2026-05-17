import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext";
import { getCloudSyncEnabled, isLocalDashboardHost } from "../lib/cloud-sync-prefs";
import { runCloudUsageSyncIfDue } from "../lib/cloud-sync";

function isSharePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/share" || p === "/share.html" || p.startsWith("/share/");
}

function isCloudSyncRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/login" || p === "/landing") return false;
  if (isSharePath(p)) return false;
  return p === "/" || p === "/dashboard" || p.startsWith("/leaderboard");
}

/**
 * 在 localhost 且处于仪表盘/排行榜路由、已登录、用户未关闭「同步到云端」时，节流触发本地 sync → 云端 ingest。
 */
export function useCloudUsageSync(): void {
  const location = useLocation();
  const insforge = useInsforgeAuth();
  const runRef = useRef(false);

  useEffect(() => {
    if (!isLocalDashboardHost()) return;
    if (!isCloudSyncRoute(location.pathname || "/")) return;
    if (!insforge.enabled || !insforge.signedIn || insforge.loading) return;
    if (!getCloudSyncEnabled()) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      (async () => {
        if (cancelled || runRef.current) return;
        runRef.current = true;
        try {
          await runCloudUsageSyncIfDue(() => insforge.getAccessToken());
        } catch (e) {
          console.warn("[tokentracker] cloud usage sync:", e);
        } finally {
          runRef.current = false;
        }
      })();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    location.pathname,
    insforge.enabled,
    insforge.signedIn,
    insforge.loading,
    insforge.getAccessToken,
  ]);
}
