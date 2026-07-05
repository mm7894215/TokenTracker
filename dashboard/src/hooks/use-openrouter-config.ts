import { useCallback, useEffect, useState } from "react";
import {
  clearOpenRouterConfig,
  getOpenRouterConfig,
  probeOpenRouterConfig,
  saveOpenRouterConfig,
  type OpenRouterConfigSnapshot,
} from "../lib/api";

type OpenRouterConfigState = {
  loading: boolean;
  saving: boolean;
  testing: boolean;
  clearing: boolean;
  error: string | null;
  snapshot: OpenRouterConfigSnapshot | null;
  refresh: () => Promise<void>;
  save: (apiKey: string, options?: { sync?: boolean }) => Promise<void>;
  clear: () => Promise<void>;
  test: (apiKey: string) => Promise<void>;
};

export function useOpenRouterConfig(enabled = true): OpenRouterConfigState {
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OpenRouterConfigSnapshot | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const next = await getOpenRouterConfig();
      setSnapshot(next);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (apiKey: string, options: { sync?: boolean } = {}) => {
      setSaving(true);
      setError(null);
      try {
        const next = await saveOpenRouterConfig({
          apiKey,
          verify: true,
          sync: options.sync === true,
        });
        setSnapshot(next);
      } catch (err: any) {
        setError(err?.message || String(err));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const test = useCallback(async (apiKey: string) => {
    setTesting(true);
    setError(null);
    try {
      await probeOpenRouterConfig({ apiKey });
    } catch (err: any) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setTesting(false);
    }
  }, []);

  const clear = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      const next = await clearOpenRouterConfig();
      setSnapshot(next);
    } catch (err: any) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setClearing(false);
    }
  }, []);

  return {
    loading,
    saving,
    testing,
    clearing,
    error,
    snapshot,
    refresh,
    save,
    clear,
    test,
  };
}
