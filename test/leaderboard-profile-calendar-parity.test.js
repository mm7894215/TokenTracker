"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../dashboard/edge-patches/tokentracker-leaderboard-profile.ts"),
  "utf8",
);

test("leaderboard profile groups usage in the caller's calendar timezone", () => {
  assert.match(source, /p_tz:\s*timeZone/);
  assert.match(source, /p_offset_min:\s*timeZoneOffsetMinutes/);
  assert.match(source, /computeStreak\(activeDaySet,\s*todayDay\)/);
  assert.doesNotMatch(source, /p_tz:\s*null/);
});

test("leaderboard profile excludes zero-token buckets from activity statistics", () => {
  assert.match(source, /\.filter\(\(\[, tokens\]\) => tokens > 0\)/);
  assert.match(source, /if \(tokens <= 0\) continue/);
  assert.match(source, /const activeDays = activeDaySet\.size/);
});
