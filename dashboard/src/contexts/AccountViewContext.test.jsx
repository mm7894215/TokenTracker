import React from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountViewProvider, useAccountView } from "./AccountViewContext.jsx";

vi.mock("./InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => ({ enabled: true, signedIn: true, loading: false }),
}));

const prefState = vi.hoisted(() => ({ ready: false, localHost: true }));

vi.mock("../lib/cloud-sync-prefs", () => ({
  CLOUD_USAGE_SYNCED_EVENT: "tt.cloudUsageSynced",
  getCloudSyncEnabled: () => true,
  getCloudUsageReady: () => prefState.ready,
  isLocalDashboardHost: () => prefState.localHost,
  syncCloudSyncPrefToLocalServer: vi.fn(),
}));

describe("AccountViewProvider", () => {
  beforeEach(() => {
    prefState.ready = false;
    prefState.localHost = true;
  });

  it("keeps the local view until the first cloud upload completes", () => {
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current).toMatchObject({ accountView: false, revision: 0 });
    act(() => window.dispatchEvent(new Event("tt.cloudUsageSynced")));
    expect(result.current.accountView).toBe(true);
  });

  it("uses cloud immediately when a previous upload is ready", () => {
    prefState.ready = true;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current.accountView).toBe(true);
  });

  it("keeps public-host account reads on cloud", () => {
    prefState.localHost = false;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current.accountView).toBe(true);
  });
});
