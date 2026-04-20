const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("budget alert helper detects forecasted monthly overruns", async () => {
  const { buildBudgetAlert } = await import("../dashboard/src/lib/budget-alerts.js");

  const alert = buildBudgetAlert({
    period: "month",
    from: "2026-04-01",
    to: "2026-04-30",
    totalCostUsd: "60",
    budgets: { monthly: 100 },
    topProject: { project_key: "octo/api" },
    now: new Date("2026-04-10T12:00:00Z"),
  });

  assert.equal(alert.status, "forecast");
  assert.equal(alert.topProject, "octo/api");
  assert.ok(alert.projected > alert.budget);
});

test("budget alert helper returns null when budget is not exceeded", async () => {
  const { buildBudgetAlert } = await import("../dashboard/src/lib/budget-alerts.js");
  const alert = buildBudgetAlert({
    period: "week",
    from: "2026-04-14",
    to: "2026-04-20",
    totalCostUsd: "20",
    budgets: { weekly: 100 },
    now: new Date("2026-04-20T12:00:00Z"),
  });
  assert.equal(alert, null);
});

test("dashboard wires budget alerts and controllable project tab", () => {
  const dashboardSrc = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/pages/DashboardPage.jsx"),
    "utf8",
  );
  const detailsSrc = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/ui/matrix-a/components/DataDetails.jsx"),
    "utf8",
  );

  assert.match(dashboardSrc, /buildBudgetAlert/);
  assert.match(dashboardSrc, /detailsActiveTab/);
  assert.match(detailsSrc, /activeTab/);
  assert.match(detailsSrc, /onActiveTabChange/);
});
