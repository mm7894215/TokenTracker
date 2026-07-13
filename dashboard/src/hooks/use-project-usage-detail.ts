import { useEffect, useState } from "react";
import { isMockEnabled } from "../lib/mock-data";
import { getProjectUsageDetail } from "../lib/api";

// Drill-down data for the Project Usage modal. Local-only endpoint — no
// auth token needed (mirrors the summary hook's local mode) and only
// fetched while a project is actually open (projectKey != null).
export function useProjectUsageDetail({
  projectKey,
  from,
  to,
  timeZone,
  tzOffsetMinutes,
}: any = {}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();

  useEffect(() => {
    if (!projectKey) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    getProjectUsageDetail({ projectKey, from, to, timeZone, tzOffsetMinutes })
      .then((res) => {
        if (!active) return;
        setData(res || null);
      })
      .catch((err) => {
        if (!active) return;
        setError((err as any)?.message || String(err));
        setData(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectKey, from, to, timeZone, tzOffsetMinutes, mockEnabled]);

  return { data, loading, error };
}
