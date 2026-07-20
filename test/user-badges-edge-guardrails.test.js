const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const edgePath = path.join(
  __dirname,
  "..",
  "dashboard",
  "edge-patches",
  "tokentracker-leaderboard-profile.ts",
);
const edge = fs.readFileSync(edgePath, "utf8");

test("badges-only profile requests return before the usage aggregation", () => {
  const fastPath = edge.indexOf('url.searchParams.get("view") === "badges"');
  const usageScan = edge.indexOf("groupedRows = await fetchDailyGroupedRows");

  assert.notEqual(fastPath, -1, "missing badges-only fast path");
  assert.notEqual(usageScan, -1, "missing full profile usage aggregation");
  assert.ok(fastPath < usageScan, "badges-only branch must precede the usage aggregation");
  assert.match(edge, /if \(!isSelf\) return json\(\{ error: "Forbidden" \}, 403\)/);
  assert.match(edge, /rpc\("user_badges_full", \{\s*p_user_id: userId,\s*p_include_unearned: true/);
});
