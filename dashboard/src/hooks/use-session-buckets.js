import { useCallback, useEffect, useState } from "react";
import { getSessionBuckets } from "../lib/api";

export function useSessionBuckets({ limit = 20 } = {}) {
  const [entries, setEntries] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const res = await getSessionBuckets({ limit });
      setEntries(Array.isArray(res?.entries) ? res.entries : []);
    } catch {
      setEntries([]);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { entries, refresh };
}
