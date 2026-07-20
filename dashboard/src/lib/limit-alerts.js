import { computePace, resetToMs, resolveWindowSeconds } from "./limit-pace.js";
import { notifyNative } from "./native-bridge.js";
import { PROVIDER_LIMIT_SPECS } from "../ui/dashboard/components/usage-limits-provider-specs.js";
import { limitProviderName } from "./limits-providers.js";
import { copy } from "./copy";

const STORAGE_KEY = "tt.limitAlerts.cycles.v1";

function readCycles() {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function writeCycles(value) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* restricted webview */ }
}

export function buildPredictiveLimitAlerts(dataById, { now = Date.now() } = {}) {
  const alerts = [];
  const specs = PROVIDER_LIMIT_SPECS;
  for (const [providerId, data] of Object.entries(dataById || {})) {
    const providerSpec = specs[providerId];
    if (!data?.configured || data.error || !providerSpec) continue;
    for (const spec of providerSpec.windows(data)) {
      if (!spec.window) continue;
      const usedPercent = Number(spec.pctField === "utilization" ? spec.window.utilization : spec.window.used_percent);
      const resetValue = spec.resetField === "resets_at" ? spec.window.resets_at : spec.window.reset_at;
      const resetMs = resetToMs(resetValue);
      const pace = computePace({
        usedPercent,
        windowSeconds: resolveWindowSeconds(spec, spec.window),
        resetMs,
        mode: "used",
        now,
      });
      if (!pace.runsOutEta || !pace.paceOver || usedPercent < 20 || !(resetMs > now)) continue;
      alerts.push({
        id: `${providerId}:${spec.key}:${resetMs}`,
        providerId,
        windowKey: spec.key,
        resetMs,
        usedPercent,
        runsOutEta: pace.runsOutEta,
      });
    }
  }
  return alerts;
}

export function sendPredictiveLimitAlerts(dataById) {
  const cycles = readCycles();
  const alerts = buildPredictiveLimitAlerts(dataById);
  for (const alert of alerts) {
    if (cycles[alert.id]) continue;
    const provider = limitProviderName(alert.providerId);
    const title = copy("limits.alert.title", { provider });
    const body = copy("limits.alert.body", { eta: alert.runsOutEta, percent: Math.round(alert.usedPercent) });
    let delivered = notifyNative({ title, body, id: alert.id });
    if (!delivered && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: alert.id });
      delivered = true;
    }
    // Only a delivered alert consumes its once-per-cycle slot; if no channel
    // accepted it (e.g. permission still pending), retry on a later poll.
    if (delivered) cycles[alert.id] = Date.now();
  }
  // Bound storage and discard cycles that reset more than a day ago.
  const cutoff = Date.now() - 86400_000;
  const bounded = Object.fromEntries(Object.entries(cycles).filter(([id, timestamp]) => {
    const resetMs = Number(id.split(":").at(-1));
    return (Number.isFinite(resetMs) ? resetMs >= cutoff : Number(timestamp) >= cutoff);
  }).slice(-100));
  writeCycles(bounded);
  return alerts.length;
}
