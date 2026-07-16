import { describe, it, expect, beforeEach } from "vitest";
import {
  emitCloudUsageSynced,
  getCloudSyncEnabled,
  getCloudUsageReady,
  setCloudSyncEnabled,
  setCloudUsageReady,
} from "./cloud-sync-prefs";

const KEY_ENABLED = "tokentracker_cloud_sync_enabled";

describe("getCloudSyncEnabled default", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to enabled when the preference was never set", () => {
    expect(getCloudSyncEnabled()).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    localStorage.setItem(KEY_ENABLED, "0");
    expect(getCloudSyncEnabled()).toBe(false);
  });

  it("keeps an explicit opt-in", () => {
    localStorage.setItem(KEY_ENABLED, "1");
    expect(getCloudSyncEnabled()).toBe(true);
  });
});

describe("cloud usage readiness", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to not ready until the first upload completes", () => {
    expect(getCloudUsageReady()).toBe(false);
  });

  it("persists readiness when cloud upload completes", () => {
    emitCloudUsageSynced();
    expect(getCloudUsageReady()).toBe(true);
  });

  it("clears readiness when cloud sync is disabled", () => {
    setCloudUsageReady(true);
    setCloudSyncEnabled(false);
    expect(getCloudUsageReady()).toBe(false);
  });
});
