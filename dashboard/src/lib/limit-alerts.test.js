import { describe, expect, it } from "vitest";
import { buildPredictiveLimitAlerts } from "./limit-alerts.js";

describe("buildPredictiveLimitAlerts", () => {
  it("alerts only when the current pace projects exhaustion before reset", () => {
    const now = Date.parse("2026-07-18T02:30:00Z");
    const reset = new Date(now + 2.5 * 60 * 60_000).toISOString();
    const alerts = buildPredictiveLimitAlerts({
      claude: { configured: true, five_hour: { utilization: 80, resets_at: reset } },
    }, { now });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].providerId).toBe("claude");
  });

  it("does not alert when usage is on pace", () => {
    const now = Date.parse("2026-07-18T00:30:00Z");
    const reset = new Date(now + 4.5 * 60 * 60_000).toISOString();
    expect(buildPredictiveLimitAlerts({
      claude: { configured: true, five_hour: { utilization: 5, resets_at: reset } },
    }, { now })).toEqual([]);
  });
});
