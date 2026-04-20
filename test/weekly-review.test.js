const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("weekly review helper summarizes the last two weeks", async () => {
  const { buildWeeklyReview } = await import("../dashboard/src/lib/weekly-review.js");

  const review = buildWeeklyReview({
    dailyRows: [
      { day: "2026-04-01", billable_total_tokens: 100 },
      { day: "2026-04-02", billable_total_tokens: 150 },
      { day: "2026-04-03", billable_total_tokens: 200 },
      { day: "2026-04-04", billable_total_tokens: 250 },
      { day: "2026-04-05", billable_total_tokens: 300 },
      { day: "2026-04-06", billable_total_tokens: 350 },
      { day: "2026-04-07", billable_total_tokens: 400 },
      { day: "2026-04-08", billable_total_tokens: 500 },
      { day: "2026-04-09", billable_total_tokens: 600 },
      { day: "2026-04-10", billable_total_tokens: 700 },
      { day: "2026-04-11", billable_total_tokens: 800 },
      { day: "2026-04-12", billable_total_tokens: 900 },
      { day: "2026-04-13", billable_total_tokens: 1000 },
      { day: "2026-04-14", billable_total_tokens: 1100 },
    ],
    projectEntries: [
      { project_key: "octo/api", billable_total_tokens: 2400 },
      { project_key: "octo/web", billable_total_tokens: 1200 },
    ],
    topModels: [{ name: "gpt-5.4", percent: "61.2" }],
  });

  assert.equal(review.total, 5600);
  assert.equal(review.previousTotal, 1750);
  assert.equal(review.topDay.day, "2026-04-14");
  assert.equal(review.topProject.name, "octo/api");
  assert.equal(review.topModel.name, "gpt-5.4");
  assert.equal(
    review.recommendationKey,
    "dashboard.weekly_review.recommendation.project",
  );
});

test("dashboard wires the weekly review card into the left column", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "dashboard/src/ui/matrix-a/views/DashboardView.jsx"),
    "utf8",
  );
  assert.match(src, /WeeklyReviewCard/);
  assert.match(src, /weeklyReviewRows/);
});
