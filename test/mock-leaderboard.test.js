const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

test("mock leaderboard returns entries and me", async () => {
  const { getMockLeaderboard } = await loadDashboardModule("dashboard/src/lib/mock-data.ts");
  const res = getMockLeaderboard({ seed: "demo", limit: 30, offset: 0 });
  assert.equal(res.period, "week");
  assert.equal(Array.isArray(res.entries), true);
  assert.ok(res.entries.length <= 30);
  assert.ok(res.me);
  assert.equal(typeof res.me.rank, "number");
  assert.equal(typeof res.me.gpt_tokens, "string");
  assert.equal(typeof res.me.claude_tokens, "string");
  assert.equal(typeof res.me.gemini_tokens, "string");
  assert.equal(typeof res.me.cursor_tokens, "string");
  assert.equal(typeof res.me.opencode_tokens, "string");
  assert.equal(typeof res.me.openclaw_tokens, "string");
  assert.equal(typeof res.me.hermes_tokens, "string");
  assert.equal(typeof res.me.kiro_tokens, "string");
  assert.equal(typeof res.me.copilot_tokens, "string");
  assert.equal(typeof res.me.kimi_tokens, "string");
  assert.equal(typeof res.me.other_tokens, "string");
  assert.equal(typeof res.me.total_tokens, "string");

  let privateCount = 0;
  for (const entry of res.entries) {
    assert.equal(typeof entry.is_public, "boolean");
    if (entry.is_public) {
      assert.equal(typeof entry.user_id, "string");
      assert.ok(entry.user_id.length > 0);
    } else {
      privateCount += 1;
      assert.equal(entry.user_id, null);
      assert.equal(entry.display_name, "Anonymous");
    }
  }

  assert.ok(privateCount > 0);
});
