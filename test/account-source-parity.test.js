"use strict";

// The "account-level source" classification (sources whose data comes from a
// per-ACCOUNT cloud API and is therefore deduped — not summed — across a user's
// devices) is hardcoded in several places that MUST agree:
//   - src/lib/source-metadata.js               (authoritative, used by the CLI)
//   - scripts/ops/account-usage-grouped-rpc.sql (account view RPC)
//   - scripts/ops/leaderboard-usage-grouped-rpc.sql (leaderboard RPC)
//   - dashboard/edge-patches/tokentracker-leaderboard-profile.ts (profile edge)
// A drift (e.g. adding a new account-level source to source-metadata.js but
// forgetting the SQL) silently re-introduces the cross-device double-count bug
// that v0.44 fixed. This test fails loudly on any mismatch.

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// new Set(["a", "b"]) / new Set<string>(["a"]) -> ["a", "b"] (sorted)
function extractJsSet(content, varName) {
  const re = new RegExp(`${varName}\\s*=\\s*new Set(?:<[^>]*>)?\\(\\[([^\\]]*)\\]\\)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .sort();
}

// ARRAY['a','b']::text[] AS account_sources -> ["a", "b"] (sorted)
function extractSqlAccountSources(content) {
  const m = content.match(/ARRAY\[([^\]]*)\]::text\[\]\s+AS\s+account_sources/);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .sort();
}

test("account-level source list is identical across source-metadata, both RPCs, and the profile edge", () => {
  const authoritative = extractJsSet(
    readFile("src/lib/source-metadata.js"),
    "ACCOUNT_LEVEL_SOURCES",
  );
  assert.ok(
    authoritative && authoritative.length > 0,
    "ACCOUNT_LEVEL_SOURCES not found in src/lib/source-metadata.js",
  );

  const others = {
    "account-usage-grouped-rpc.sql": extractSqlAccountSources(
      readFile("scripts/ops/account-usage-grouped-rpc.sql"),
    ),
    "leaderboard-usage-grouped-rpc.sql": extractSqlAccountSources(
      readFile("scripts/ops/leaderboard-usage-grouped-rpc.sql"),
    ),
    "tokentracker-leaderboard-profile.ts": extractJsSet(
      readFile("dashboard/edge-patches/tokentracker-leaderboard-profile.ts"),
      "ACCOUNT_LEVEL_SOURCES",
    ),
  };

  for (const [name, list] of Object.entries(others)) {
    assert.ok(list, `could not extract account-level source list from ${name}`);
    assert.deepStrictEqual(
      list,
      authoritative,
      `${name} account-level source list ${JSON.stringify(list)} must equal ` +
        `source-metadata.js ${JSON.stringify(authoritative)} — update all sites together`,
    );
  }
});
