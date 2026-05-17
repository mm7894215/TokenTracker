import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useInsforgeAuth } from "./InsforgeAuthContext.jsx";
import { getCloudSyncEnabled, isLocalDashboardHost } from "../lib/cloud-sync-prefs";

/**
 * AccountViewContext decides whether the dashboard reads aggregated cloud
 * data (cross-device, via tokentracker-account-*) or the local CLI queue
 * (per-device, via /functions/tokentracker-usage-*).
 *
 * Two host modes:
 *   - localhost dashboard: signed-in user can opt in via Settings →
 *     Account → Cloud sync toggle. When on, reads switch to cloud.
 *   - non-localhost (e.g. www.tokentracker.cc): the local CLI endpoints
 *     are unreachable, so signed-in users are pinned to cloud reads. A
 *     signed-out visitor on the public host has nothing to render — the
 *     consumer is expected to gate on `signedIn` before calling hooks.
 *
 * `revision` increments whenever the resolved mode flips, so dependent
 * hooks can invalidate their state and avoid showing stale data from the
 * other scope while the new fetch is in flight.
 */
const AccountViewContext = createContext(null);

export const CLOUD_SYNC_CHANGE_EVENT = "tt.cloudSyncChanged";

export function emitCloudSyncChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CLOUD_SYNC_CHANGE_EVENT));
}

export function AccountViewProvider({ children }) {
  const auth = useInsforgeAuth();
  const signedIn = Boolean(auth?.signedIn);
  const authEnabled = Boolean(auth?.enabled);

  const [localHost, setLocalHost] = useState(() => isLocalDashboardHost());
  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setLocalHost(isLocalDashboardHost());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refresh = () => {
      const next = getCloudSyncEnabled();
      setCloudSyncOn((prev) => {
        if (prev === next) return prev;
        setRevision((n) => n + 1);
        return next;
      });
    };
    window.addEventListener(CLOUD_SYNC_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CLOUD_SYNC_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Public host: cloud is mandatory for signed-in users; signed-out users
  // get a no-data state (false) but the page should redirect to /login.
  // Local host: opt-in via the toggle.
  const accountView = useMemo(() => {
    if (!authEnabled || !signedIn) return false;
    if (!localHost) return true;
    return cloudSyncOn;
  }, [authEnabled, signedIn, localHost, cloudSyncOn]);

  // Bump revision when the mode flips so hooks can wipe stale scope state.
  const lastResolved = React.useRef(accountView);
  useEffect(() => {
    if (lastResolved.current !== accountView) {
      lastResolved.current = accountView;
      setRevision((n) => n + 1);
    }
  }, [accountView]);

  const value = useMemo(
    () => ({ accountView, revision, localHost }),
    [accountView, revision, localHost],
  );

  return (
    <AccountViewContext.Provider value={value}>{children}</AccountViewContext.Provider>
  );
}

export function useAccountView() {
  const ctx = useContext(AccountViewContext);
  if (ctx) return ctx;
  return { accountView: false, revision: 0, localHost: true };
}
