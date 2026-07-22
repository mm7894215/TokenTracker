const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Skills cloud inventory guardrails", () => {
  it("keeps the database browser-inaccessible and device-scoped", () => {
    const sql = read("migrations/20260721113000_add-device-skill-inventories.sql");
    assert.match(sql, /PRIMARY KEY \(user_id, device_id\)/);
    assert.match(sql, /REFERENCES public\.tokentracker_devices\(id\) ON DELETE CASCADE/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /jsonb_array_length\(skills\) <= 2000/);
  });

  it("verifies JWT ownership and strips content-bearing fields", () => {
    const source = read("dashboard/edge-patches/tokentracker-account-skills.ts");
    assert.match(source, /verifiedUserIdFromJwt/);
    assert.match(source, /\.eq\("id", deviceId\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.is\("revoked_at", null\)/);
    assert.match(source, /sanitizeSkill/);
    assert.match(source, /raw\.startsWith\("\/"\)/);
    assert.match(source, /cleanStableKey/);
    assert.match(source, /scopeInput === "system"\) return null/);
    assert.match(source, /skills\.filter\(\(skill\) => skill\?\.scope !== "system"\)/);
    assert.match(source, /description, SKILL\.md content, prompts, readme URLs, and absolute paths/);
    assert.doesNotMatch(source, /input\.description|input\.prompt|input\.content|input\.readmeUrl|input\.targetPaths/);
  });

  it("bounds cloud requests so the local inventory remains usable", () => {
    const source = read("dashboard/src/lib/skills-api.ts");
    assert.match(source, /CLOUD_REQUEST_TIMEOUT_MS/);
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /signal: controller\.signal/);
    assert.match(source, /finally[\s\S]*clearTimeout\(timeout\)/);
  });
});
