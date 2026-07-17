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
    /SET name_customized = true/u,
    "existing user-renamed rows must be backfilled so they are protected immediately",
  );
});

test("rename endpoint marks the device name as user-customized", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\.update\(\{ device_name: name, name_customized: true \}\)/u,
    "rename must set name_customized so token issuance stops refreshing the name",
  );
});

test("rename endpoint survives being deployed before the migration", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\/name_customized\/i\.test\(error\.message/u,
    "rename must fall back to the legacy update when the column is missing (deploy-order safety net)",
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
