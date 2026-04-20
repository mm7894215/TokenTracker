import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectUsageDetail } from "../lib/api";

export function useProjectUsageDetail({
  projectKey,
  from,
  to,
  compareFrom,
  compareTo,
  timeZone,
  tzOffsetMinutes,
  open,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!open || !projectKey) {
      requestIdRef.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setData(null);
    setError(null);
    setLoading(true);
    try {
      const res = await getProjectUsageDetail({
        projectKey,
        from,
        to,
        compareFrom,
        compareTo,
        timeZone,
        tzOffsetMinutes,
      });
      if (requestId !== requestIdRef.current) return;
      setData(res);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setData(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [compareFrom, compareTo, from, open, projectKey, timeZone, to, tzOffsetMinutes]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error };
}
