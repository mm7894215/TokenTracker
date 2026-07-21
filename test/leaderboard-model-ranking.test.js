const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("model leaderboard snapshots stay aggregate, bounded, and server-only", () => {
  const sql = read("migrations/20260721213000_add-model-leaderboard-snapshots.sql");
  assert.match(sql, /PRIMARY KEY \(period, from_day, to_day\)/);
  assert.match(sql, /jsonb_array_length\(entries\) <= 500/);
  assert.match(sql, /total_models = jsonb_array_length\(entries\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test("leaderboard refresh derives period model ranks from the existing grouped RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  assert.match(source, /MODEL_LEADERBOARD_MIN_DEVELOPERS = 3/);
  assert.match(source, /MODEL_LEADERBOARD_MAX_ROWS = 500/);
  assert.match(source, /model\.developer_ids\.size >= MODEL_LEADERBOARD_MIN_DEVELOPERS/);
  assert.match(source, /from\("tokentracker_model_leaderboard_snapshots"\)[\s\S]*entries: modelRows/);
  assert.match(source, /groupedData[\s\S]*modelAggMap/);
  assert.doesNotMatch(source, /entries:\s*[^\n]*user_id/);
});

test("public reader exposes a paginated model dimension without user rows", () => {
  const edge = read("dashboard/edge-patches/tokentracker-leaderboard.ts");
  const api = read("dashboard/src/lib/api.ts");
  assert.match(edge, /dimension.*=== "models"/);
  assert.match(edge, /allEntries\.slice\(offset, offset \+ limit\)/);
  assert.match(edge, /privacy: \{ minimum_developers: 3 \}/);
  assert.match(api, /params: \{ period, dimension, limit, offset, user_id: userId \}/);
});
