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
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const MIGRATION = "migrations/20260719145649_add-device-name-customized.sql";
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

async function loadDeviceFlowIssuer() {
  const source = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts")
    .replace(
      'import { createClient } from "npm:@insforge/sdk";',
      "const createClient = () => globalThis.__unusedEdgeTestClient;",
    )
    .concat("\nexport { issueDeviceToken as testIssueDeviceToken };\n");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(url);
}

async function loadDashboardTokenIssueHandler() {
  const source = read("dashboard/edge-patches/tokentracker-device-token-issue.ts")
    .replace(
      'import { createClient } from "npm:@insforge/sdk";',
      "const createClient = () => globalThis.__edgeTestClient;",
    );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(url);
}

function createEdgeDatabaseMock() {
  const devices = [];
  const tokens = [];

  function from(table) {
    let operation = "select";
    let values = null;
    let filters = [];
    let maxRows = Infinity;

    const query = {
      select() {
        return query;
      },
      upsert(rows) {
        operation = "upsert";
        values = rows;
        return query;
      },
      update(nextValues) {
        operation = "update";
        values = nextValues;
        return query;
      },
      insert(rows) {
        operation = "insert";
        values = rows;
        return query;
      },
      eq(column, value) {
        filters.push((row) => row[column] === value);
        return query;
      },
      is(column, value) {
        filters.push((row) => (row[column] ?? null) === value);
        return query;
      },
      in(column, candidates) {
        filters.push((row) => candidates.includes(row[column]));
        return query;
      },
      order() {
        return query;
      },
      limit(value) {
        maxRows = value;
        return query;
      },
      maybeSingle() {
        const result = execute();
        return Promise.resolve({ data: result.data[0] || null, error: result.error });
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };

    const matches = (row) => filters.every((filter) => filter(row));
    function execute() {
      const rows = table === "tokentracker_devices" ? devices : tokens;
      if (operation === "select") {
        return { data: rows.filter(matches).slice(0, maxRows), error: null };
      }
      if (operation === "upsert") {
        const inserted = [];
        for (const value of values) {
          const conflict = devices.some((row) =>
            row.revoked_at == null
              && row.user_id === value.user_id
              && (
                (row.platform === value.platform && row.device_name === value.device_name)
                || (value.machine_id && row.machine_id === value.machine_id)
              ));
          if (!conflict) {
            const row = { revoked_at: null, ...value };
            devices.push(row);
            inserted.push(row);
          }
        }
        return { data: inserted, error: null };
      }
      if (operation === "update") {
        const targetRows = rows.filter(matches);
        if (table === "tokentracker_devices") {
          // Model the active-name unique index: renaming an active row onto a
          // name another active row of the same (user, platform) owns fails.
          for (const row of targetRows) {
            const nextName = Object.prototype.hasOwnProperty.call(values, "device_name")
              ? values.device_name
              : row.device_name;
            const conflict = devices.some((other) =>
              other !== row
                && other.revoked_at == null
                && other.user_id === row.user_id
                && other.platform === row.platform
                && other.device_name === nextName);
            if (conflict) {
              return { data: null, error: { message: 'duplicate key value violates unique constraint "tokentracker_devices_active_name_key"' } };
            }
          }
        }
        for (const row of targetRows) Object.assign(row, values);
        return { data: targetRows, error: null };
      }
      if (operation === "insert") {
        const inserted = values.map((value) => ({ revoked_at: null, ...value }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      throw new Error(`unsupported mock operation: ${operation}`);
    }

    return query;
  }

  return {
    client: {
      database: {
        from,
        rpc: async () => ({ data: true, error: null }),
      },
    },
    devices,
  };
}

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
    /\.in\("default_device_name", legacyNames\)/u,
    "device-flow-poll adoption must fall back to the preserved pre-rename default name",
  );
});

test("device uploads keep machine identity separate from readable system names", () => {
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  assert.match(
    tokenIssue,
    /`Token Tracker \(dashboard\) #\$\{machineId\.slice\(0, 8\)\}`/u,
    "hostname rollout must still adopt the previous dashboard hash label",
  );
  assert.match(
    tokenIssue,
    /legacyNameCustomized[\s\S]{0,180}\{ machine_id: machineId, device_name: deviceName \}/u,
    "legacy adoption must refresh generated labels without overwriting custom names",
  );

  const flowPoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  assert.ok(
    flowPoll.includes("const hostnameMatch = clientInfo?.match(/^\\S+\\s+(.+)$/);"),
    "CLI device flow must only extract a hostname when client_info has the expected separator",
  );
  assert.match(
    flowPoll,
    /generatedLegacyName[\s\S]*?\.in\("device_name", legacyNames\)/u,
    "CLI hostname rollout must continue adopting generated legacy names",
  );
});

test("two machines with the same hostname register as distinct devices", async () => {
  const { testIssueDeviceToken } = await loadDeviceFlowIssuer();
  const { client, devices } = createEdgeDatabaseMock();
  const hostname = "MacBook-Pro.local";
  const firstMachineId = "a".repeat(64);
  const secondMachineId = "b".repeat(64);

  const first = await testIssueDeviceToken(
    client,
    "same-user",
    `darwin-arm64 ${hostname}`,
    firstMachineId,
  );
  const second = await testIssueDeviceToken(
    client,
    "same-user",
    `darwin-arm64 ${hostname}`,
    secondMachineId,
  );

  assert.notEqual(first.deviceId, second.deviceId);
  assert.deepEqual(
    devices.map((device) => ({
      name: device.device_name,
      machineId: device.machine_id,
    })),
    [
      { name: hostname, machineId: firstMachineId },
      { name: `${hostname} #bbbbbbbb`, machineId: secondMachineId },
    ],
  );

  const { default: issueDashboardToken } = await loadDashboardTokenIssueHandler();
  const dashboardDb = createEdgeDatabaseMock();
  const previousDeno = globalThis.Deno;
  const previousEdgeTestClient = globalThis.__edgeTestClient;
  globalThis.__edgeTestClient = dashboardDb.client;
  globalThis.Deno = {
    env: {
      get(name) {
        return {
          INSFORGE_BASE_URL: "https://cloud.example",
          INSFORGE_SERVICE_ROLE_KEY: "test-service-role",
          INSFORGE_ANON_KEY: "test-anon-key",
        }[name];
      },
    },
  };
  try {
    for (const machineId of [firstMachineId, secondMachineId]) {
      const response = await issueDashboardToken(new Request("https://cloud.example/functions/device-token", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-service-role",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: "same-user",
          device_name: hostname,
          platform: "desktop",
          machine_id: machineId,
        }),
      }));
      assert.equal(response.status, 200, await response.text());
    }
  } finally {
    globalThis.Deno = previousDeno;
    globalThis.__edgeTestClient = previousEdgeTestClient;
  }
  assert.deepEqual(
    dashboardDb.devices.map((device) => device.device_name),
    [hostname, `${hostname} #bbbbbbbb`],
  );

  for (const relativePath of [
    "dashboard/edge-patches/tokentracker-device-token-issue.ts",
    "dashboard/edge-patches/tokentracker-device-flow-poll.ts",
  ]) {
    const source = read(relativePath);
    assert.match(
      source,
      /const fallbackDeviceName = disambiguateDeviceName\(deviceName, machineId\)/u,
      `${relativePath} must retry same-hostname registration with a stable suffix`,
    );
  }
});

test("legacy CLI client info without a hostname keeps the generated label", async () => {
  const { testIssueDeviceToken } = await loadDeviceFlowIssuer();
  const { client, devices } = createEdgeDatabaseMock();

  await testIssueDeviceToken(
    client,
    "legacy-user",
    "darwin-arm64",
    "c".repeat(64),
  );

  assert.equal(devices[0].device_name, "TokenTracker CLI (darwin-arm64) #cccccccc");
});

test("CLI adoption keeps the legacy label when another machine owns the hostname", async () => {
  const { testIssueDeviceToken } = await loadDeviceFlowIssuer();
  const { client, devices } = createEdgeDatabaseMock();
  const hostname = "MacBook-Pro.local";
  const machineA = "a".repeat(64);
  const machineB = "b".repeat(64);
  devices.push(
    {
      id: "machine-a-device",
      user_id: "same-user",
      device_name: hostname,
      platform: "cli-device-flow",
      machine_id: machineA,
      revoked_at: null,
      name_customized: false,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "orphan-b",
      user_id: "same-user",
      device_name: `TokenTracker CLI (darwin-arm64 ${hostname}) #bbbbbbbb`,
      default_device_name: `TokenTracker CLI (darwin-arm64 ${hostname}) #bbbbbbbb`,
      platform: "cli-device-flow",
      machine_id: null,
      revoked_at: null,
      name_customized: false,
      created_at: "2026-01-02T00:00:00.000Z",
    },
  );

  const result = await testIssueDeviceToken(
    client,
    "same-user",
    `darwin-arm64 ${hostname}`,
    machineB,
  );

  // Renaming the orphan onto the taken hostname collides with the active-name
  // unique index; adoption must fall back to machine_id-only so the historical
  // row is claimed instead of orphaned.
  assert.equal(result.deviceId, "orphan-b");
  const adopted = devices.find((device) => device.id === "orphan-b");
  assert.equal(adopted.machine_id, machineB);
  assert.equal(adopted.device_name, `TokenTracker CLI (darwin-arm64 ${hostname}) #bbbbbbbb`);
});

test("dashboard token issue keeps the legacy label when another machine owns the hostname", async () => {
  const { default: issueDashboardToken } = await loadDashboardTokenIssueHandler();
  const dashboardDb = createEdgeDatabaseMock();
  const hostname = "office-win";
  const machineA = "a".repeat(64);
  const machineB = "b".repeat(64);
  dashboardDb.devices.push(
    {
      id: "machine-a-device",
      user_id: "same-user",
      device_name: hostname,
      platform: "desktop",
      machine_id: machineA,
      revoked_at: null,
      name_customized: false,
    },
    {
      id: "orphan-b",
      user_id: "same-user",
      device_name: "Token Tracker (dashboard) #bbbbbbbb",
      platform: "desktop",
      machine_id: null,
      revoked_at: null,
      name_customized: false,
    },
  );
  const previousDeno = globalThis.Deno;
  const previousEdgeTestClient = globalThis.__edgeTestClient;
  globalThis.__edgeTestClient = dashboardDb.client;
  globalThis.Deno = {
    env: {
      get(name) {
        return {
          INSFORGE_BASE_URL: "https://cloud.example",
          INSFORGE_SERVICE_ROLE_KEY: "test-service-role",
          INSFORGE_ANON_KEY: "test-anon-key",
        }[name];
      },
    },
  };
  try {
    const response = await issueDashboardToken(new Request("https://cloud.example/functions/device-token", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-service-role",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "same-user",
        device_name: hostname,
        platform: "desktop",
        machine_id: machineB,
      }),
    }));
    assert.equal(response.status, 200, await response.text());
  } finally {
    globalThis.Deno = previousDeno;
    globalThis.__edgeTestClient = previousEdgeTestClient;
  }
  const adopted = dashboardDb.devices.find((device) => device.id === "orphan-b");
  assert.equal(adopted.machine_id, machineB);
  assert.equal(adopted.device_name, "Token Tracker (dashboard) #bbbbbbbb");
});

test("current-device labels react to the first completed cloud sync", () => {
  const dashboardPage = read("dashboard/src/pages/DashboardPage.jsx");
  assert.match(
    dashboardPage,
    /window\.addEventListener\(CLOUD_USAGE_SYNCED_EVENT, refreshCurrentDevice\)/u,
    "the current-device ID must refresh in the same tab after the first successful sync",
  );
  assert.match(
    dashboardPage,
    /setCurrentDeviceId\(getCurrentDeviceId\(\)\)/u,
    "the sync listener must re-read the newly issued device ID",
  );
});
