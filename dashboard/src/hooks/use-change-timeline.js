import { useCallback, useEffect, useState } from "react";
import { isMockEnabled } from "../lib/mock-data";

const MOCK_EVENTS = [
  { date: "2026-04-18", event_type: "source_first_seen", params: { source: "gemini" } },
  { date: "2026-04-20", event_type: "cloud_sync_configured", params: {} },
];

export function useChangeTimeline() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mockEnabled = isMockEnabled();

  const refresh = useCallback(async () => {
    if (mockEnabled) {
      setEvents(MOCK_EVENTS);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/functions/tokentracker-change-timeline", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setEvents(Array.isArray(data?.events) ? data.events : []);
    } catch (err) {
      setEvents([]);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [mockEnabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { events, loading, error, refresh };
}
