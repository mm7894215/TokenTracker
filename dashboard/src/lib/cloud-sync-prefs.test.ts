import { describe, it, expect, beforeEach } from "vitest";
import { getCloudSyncEnabled } from "./cloud-sync-prefs";

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
