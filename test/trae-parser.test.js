/**
 * Trae SOLO (ByteDance AI IDE) reader test.
 *
 * Builds synthetic Trae storage.json fixtures under a temp TRAE SOLO home and
 * verifies the detection + entitlement display scope:
 *   - resolveTraePath env precedence (TOKENTRACKER_TRAE_HOME → platform default)
 *   - resolveTraeStoragePath resolves User/globalStorage/storage.json
 *   - readTraeEntitlementFromStorage reads the normalized entitlement
 *     snapshot straight from storage.json for the status render path
 *   - missing / null / unparseable snapshots return null (no crash)
 *
 * Trae SOLO is intentionally NOT a queue source: it does not expose
 * per-request token usage in a readable local format (session transcripts are
 * SQLCipher-encrypted; memory summaries carry no token counts), so nothing is
 * ever written to the token-count-only queue.jsonl for this provider.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  resolveTraePath,
  resolveTraeStoragePath,
  readTraeEntitlementFromStorage,
  toUtcHalfHourStart,
} = require("../src/lib/rollout");

const SERVER_KEY = "iCubeServerData://icube.cloudide";

function makeTraeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trae-test-"));
}

function writeStorage(traeHome, serverDataValue) {
  const dir = path.join(traeHome, "User", "globalStorage");
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, "storage.json");
  const payload = {};
  if (serverDataValue !== undefined) payload[SERVER_KEY] = serverDataValue;
  fs.writeFileSync(storagePath, JSON.stringify(payload));
  return storagePath;
}

function sampleEntitlement(overrides = {}) {
  return {
    identityStr: "Pro",
    identity: 3,
    hasPackage: true,
    isDollarUsageBilling: false,
    proPeriod: "year",
    enableSoloBuilder: true,
    enableSoloCoder: false,
    detail: {
      fastRequestPer: 20,
      inWaitlist: false,
    },
    ...overrides,
  };
}

test("resolveTraePath honors TOKENTRACKER_TRAE_HOME override", () => {
  const override = "/custom/trae-home";
  assert.equal(
    resolveTraePath({ TOKENTRACKER_TRAE_HOME: override }),
    override,
  );
  // Whitespace-only override falls back to platform default.
  assert.notEqual(
    resolveTraePath({ TOKENTRACKER_TRAE_HOME: "   " }),
    "   ",
  );
});

test("resolveTraePath resolves a platform default on darwin", (t) => {
  if (process.platform !== "darwin") {
    t.skip("darwin-only default path");
    return;
  }
  const home = os.homedir();
  assert.equal(
    resolveTraePath({}),
    path.join(home, "Library", "Application Support", "TRAE SOLO"),
  );
});

test("resolveTraePath falls back to a deterministic home path on other platforms", (t) => {
  if (process.platform === "darwin" || process.platform === "win32") {
    t.skip("fallback path is for non-darwin/non-win32 platforms");
    return;
  }
  const home = os.homedir();
  assert.equal(
    resolveTraePath({}),
    path.join(home, ".trae-solo"),
  );
});

test("resolveTraeStoragePath returns null when storage.json is missing", () => {
  const traeHome = makeTraeHome();
  assert.equal(
    resolveTraeStoragePath({ TOKENTRACKER_TRAE_HOME: traeHome }),
    null,
  );
});

test("resolveTraeStoragePath resolves existing storage.json", () => {
  const traeHome = makeTraeHome();
  const storagePath = writeStorage(traeHome, sampleEntitlement());
  assert.equal(
    resolveTraeStoragePath({ TOKENTRACKER_TRAE_HOME: traeHome }),
    storagePath,
  );
});

test("toUtcHalfHourStart buckets to :00 and :30 UTC starts", () => {
  assert.equal(
    toUtcHalfHourStart("2026-08-07T01:15:00.000Z"),
    "2026-08-07T01:00:00.000Z",
  );
  assert.equal(
    toUtcHalfHourStart("2026-08-07T01:45:00.000Z"),
    "2026-08-07T01:30:00.000Z",
  );
});

test("readTraeEntitlementFromStorage returns a normalized snapshot from Local State", () => {
  const traeHome = makeTraeHome();
  const storagePath = writeStorage(traeHome, { entitlementInfo: sampleEntitlement() });
  const ent = readTraeEntitlementFromStorage(storagePath);
  assert.deepEqual(ent, {
    identity: "Pro",
    identity_code: 3,
    has_package: true,
    is_dollar_billing: false,
    pro_period: "year",
    enable_solo_builder: true,
    enable_solo_coder: false,
    fast_request_per: 20,
    in_waitlist: false,
    captured_at: ent.captured_at,
  });
  assert.match(ent.captured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("readTraeEntitlementFromStorage returns null for missing storage.json", () => {
  const traeHome = makeTraeHome();
  assert.equal(
    readTraeEntitlementFromStorage(path.join(traeHome, "User", "globalStorage", "storage.json")),
    null,
  );
});

test("readTraeEntitlementFromStorage returns null for top-level null storage.json", () => {
  const traeHome = makeTraeHome();
  const storagePath = path.join(traeHome, "User", "globalStorage", "storage.json");
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, "null");
  assert.equal(readTraeEntitlementFromStorage(storagePath), null);
});

test("readTraeEntitlementFromStorage returns null when serverData is JSON null", () => {
  const traeHome = makeTraeHome();
  const storagePath = writeStorage(traeHome, "null");
  assert.equal(readTraeEntitlementFromStorage(storagePath), null);
});

test("readTraeEntitlementFromStorage returns null when serverData has no entitlementInfo", () => {
  const traeHome = makeTraeHome();
  const storagePath = writeStorage(traeHome, { noEntitlement: true });
  assert.equal(readTraeEntitlementFromStorage(storagePath), null);
});
