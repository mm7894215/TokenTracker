"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

for (const relativePath of ["migrations/20260804043427_align-leaderboard-machine-clusters.sql"]) {
  test(`${relativePath} keeps machine-cluster leaderboard semantics`, () => {
    const sql = read(relativePath);

    assert.match(
      sql,
      /DISTINCT ON \(\s*h\.user_id,\s*COALESCE\(dm\.machine_cluster_id, h\.device_id::text\),\s*h\.source,\s*h\.model,\s*h\.hour_start\s*\)/u,
      "same-machine device ids must collapse before aggregation",
    );
    assert.match(
      sql,
      /LEFT JOIN tokentracker_device_machine dm\s+ON dm\.device_id = h\.device_id/u,
      "leaderboard rows must use the same cluster mapping as account profiles",
    );
    assert.match(sql, /SUM\(mac\.total_tokens\)::bigint/u);
    assert.match(
      sql,
      /GROUP BY mac\.user_id, mac\.source, mac\.model, mac\.hour_start/u,
      "distinct physical machines must be added after within-cluster dedup",
    );
    assert.match(
      sql,
      /SELECT DISTINCT ON \(h\.user_id, h\.source, h\.model, h\.hour_start\)[\s\S]{0,900}h\.source = ANY\(cfg\.account_sources\)/u,
      "account-level sources must remain globally deduplicated across devices",
    );
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.leaderboard_rollup_daily_advance_v2/u);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.leaderboard_rollup_daily_replace_v2/u);
    assert.match(sql, /WHILE v_day < p_to LOOP/u);
    assert.match(sql, /v_until := LEAST\(v_target, v_from \+ interval '7 days'\)/u);
    assert.match(sql, /Late history uploads, device revocations, and cluster-map/u);
    assert.match(sql, /SET repair_from = CASE/u);
    assert.match(sql, /FROM public\.tokentracker_leaderboard_rollup_daily_v2 r/u);
    assert.match(sql, /FROM public\.leaderboard_hourly_dedup_v2\(v_through, p_to\) t/u);
  });
}
