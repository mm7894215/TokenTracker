"use strict";

// User device renames must survive token issuance (issue: rename reverted to
// the default name on every 12h dashboard token rotation / CLI re-login).
// The `name_customized` flag is set by the rename endpoint; every edge write
// that refreshes device_name from a client-computed default must skip rows
// where the user customized the name.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const MIGRATION = "migrations/20260717060000_add-device-name-customized.sql";

test("migration adds the name_customized column and backfills renamed rows", () => {
  const source = read(MIGRATION);
  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS name_customized boolean NOT NULL DEFAULT false/u,
    "devices table must gain the name_customized flag",
  );
  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS default_device_name text/u,
    "devices table must gain default_device_name so renamed legacy rows stay adoptable",
  );
  assert.match(
    source,
    /SET name_customized = true\s*\nWHERE revoked_at IS NULL/u,
    "backfill must be scoped to active rows — revoked devices never receive keep-fresh writes",
  );
});

test("rename endpoint marks the device name as user-customized", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\{ device_name: name, name_customized: true, default_device_name: priorName \}/u,
    "rename must set name_customized and preserve the pre-rename client default",
  );
  assert.match(
    source,
    /: \{ device_name: name, name_customized: true \}/u,
    "repeated renames must not overwrite the captured default with a custom name",
  );
  assert.match(
    source,
    /\.select\("id, device_name, name_customized"\)/u,
    "rename must read the row's prior state to know whether to capture the default name",
  );
});

test("rename endpoint survives being deployed before the migration", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\/name_customized\|default_device_name\/i\.test\(error\.message/u,
    "rename must fall back to the legacy update when the columns are missing (deploy-order safety net)",
  );
});

test("token issuance never overwrites a user-customized device name", () => {
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  assert.match(
    tokenIssue,
    /\.select\("id, name_customized"\)/u,
    "token-issue must read name_customized when resolving the device by machine_id",
  );
  assert.match(
    tokenIssue,
    /name_customized \? \{ platform \} : \{ device_name: deviceName, platform \}/u,
    "token-issue keep-fresh update must skip device_name on customized rows",
  );
  assert.doesNotMatch(
    tokenIssue,
    /\.update\(\{ device_name: deviceName, platform \}\)/u,
    "token-issue must not unconditionally overwrite device_name",
  );

  const flowPoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  assert.match(
    flowPoll,
    /name_customized \? \{ platform \} : \{ device_name: deviceName, platform \}/u,
    "device-flow-poll keep-fresh update must skip device_name on customized rows",
  );
  assert.doesNotMatch(
    flowPoll,
    /\.update\(\{ device_name: deviceName, platform \}\)/u,
    "device-flow-poll must not unconditionally overwrite device_name",
  );
  assert.match(
    flowPoll,
    /name_customized[\s\S]{0,120}\{ machine_id: machineId \}[\s\S]{0,120}\{ machine_id: machineId, device_name: deviceName \}/u,
    "legacy adoption must not rename a row the user customized",
  );
});

test("renamed machine_id-less rows stay adoptable via their preserved default name", () => {
  // A rename removes the row from the client-default name space, so adoption
  // by device_name can no longer find it — without a fallback the next
  // client-upgrade login would mint a fresh device and split the history
  // (issue #187 class). Both adoption paths must retry the match against
  // default_device_name, which the rename endpoint captured.
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  assert.match(
    tokenIssue,
    /\.in\("default_device_name", legacyNames\)/u,
    "token-issue adoption must fall back to the preserved pre-rename default name",
  );

  const flowPoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  assert.match(
    flowPoll,
    /\.in\("default_device_name", \[deviceName, legacyBareName\]\)/u,
    "device-flow-poll adoption must fall back to the preserved pre-rename default name",
  );
});
