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

const MIGRATION = "migrations/20260719145649_add-device-name-customized.sql";
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

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

test("token issuance refreshes device identity through the conflict-safe RPC", () => {
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  assert.match(
    tokenIssue,
    /\.rpc\(\s*"refresh_tokentracker_device_identity"/u,
    "token-issue must delegate refresh and legacy convergence to one transaction",
  );
  assert.doesNotMatch(
    tokenIssue,
    /\.update\(row\.name_customized \? \{ platform \} : \{ device_name: deviceName, platform \}\)/u,
    "token-issue must not issue a racy direct keep-fresh UPDATE",
  );

  const flowPoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  assert.match(
    flowPoll,
    /\.rpc\(\s*"refresh_tokentracker_device_identity"/u,
    "device-flow-poll must delegate refresh and legacy convergence to one transaction",
  );
  assert.doesNotMatch(
    flowPoll,
    /\.update\(row\.name_customized \? \{ platform \} : \{ device_name: deviceName, platform \}\)/u,
    "device-flow-poll must not issue a racy direct keep-fresh UPDATE",
  );
  assert.match(
    flowPoll,
    /name_customized[\s\S]{0,120}\{ machine_id: machineId \}[\s\S]{0,120}\{ machine_id: machineId, device_name: deviceName \}/u,
    "legacy adoption must not rename a row the user customized",
  );
});

test("device identity refresh merges a matching legacy row without losing usage or custom names", () => {
  const source = readMigrationBySuffix("harden-backend-concurrency");
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.refresh_tokentracker_device_identity/u);
  assert.match(
    source,
    /SELECT d\.device_name, d\.name_customized[\s\S]{0,400}FOR UPDATE/u,
    "refresh must lock the machine-anchored row and read customization state",
  );
  assert.match(
    source,
    /legacy\.machine_id IS NULL[\s\S]{0,400}legacy\.device_name = p_device_name/u,
    "only the active machine-id-less row owning the client default may be merged",
  );
  assert.match(source, /INSERT INTO public\.tokentracker_hourly AS canonical/u);
  assert.match(
    source,
    /ORDER BY h\.total_tokens DESC, h\.updated_at DESC/u,
    "whole-row canonicalization must keep the most complete snapshot",
  );
  assert.match(source, /ON CONFLICT \(user_id, device_id, source, model, hour_start\) DO UPDATE/u);
  assert.match(
    source,
    /UPDATE public\.tokentracker_device_tokens[\s\S]{0,120}SET device_id = p_device_id/u,
    "existing legacy tokens must continue syncing into the canonical device",
  );
  assert.match(
    source,
    /UPDATE public\.tokentracker_devices[\s\S]{0,160}SET revoked_at = clock_timestamp\(\)/u,
    "the merged legacy row must leave the active aggregation set",
  );
  assert.match(
    source,
    /WHEN v_name_customized THEN v_current_name[\s\S]{0,120}WHEN COALESCE\(v_legacy_name_customized, false\) THEN v_legacy_name/u,
    "the canonical custom name wins, otherwise a custom legacy name is transferred",
  );
  assert.match(
    source,
    /EXCEPTION WHEN unique_violation THEN/u,
    "a concurrent legacy insert must be absorbed instead of escaping as a database error",
  );
  assert.match(
    source,
    /CREATE TABLE public\.tt_hourly_conflict_backup_20260719 AS/u,
    "the one-time production rewrite must keep a recoverable hourly snapshot",
  );
  assert.match(
    source,
    /RAISE EXCEPTION 'device identity convergence failed whole-row canonicalization'/u,
    "the migration must roll back instead of committing a lossy merge",
  );
  assert.match(source, /REVOKE ALL ON FUNCTION public\.refresh_tokentracker_device_identity/u);
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
