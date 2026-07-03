const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { ensureNamespacedCursors, ensureFlatCursor } = require("../src/lib/install-resolver");
const { multiInstallParse } = require("../src/lib/multi-install-parser");

test("flat cursor migrates to both namespaces", () => {
  const cursors = {
    hermes: {
      lastCompletedStartedAt: 100,
      unfinishedSessionIds: ["s1", "s2"],
      snapshots: { s1: { in: 50, out: 25 } },
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const ns = ensureNamespacedCursors(cursors, "hermes");

  assert.ok(ns.native, "native namespace should exist");
  assert.ok(ns.wsl, "wsl namespace should exist");
  assert.equal(ns.native.lastCompletedStartedAt, 100);
  assert.deepEqual(ns.native.unfinishedSessionIds, ["s1", "s2"]);
  assert.deepEqual(ns.native.snapshots, { s1: { in: 50, out: 25 } });
  assert.equal(ns.wsl.lastCompletedStartedAt, 100, "wsl should also have the flat data");
  assert.deepEqual(ns.wsl.snapshots, { s1: { in: 50, out: 25 } });
});

test("ensureFlatCursor merges namespaces back to flat", () => {
  const cursors = {
    hermes: {
      native: { lastCompletedStartedAt: 50, snapshots: {} },
      wsl: { lastCompletedStartedAt: 100, snapshots: {} },
    },
  };

  ensureFlatCursor(cursors, "hermes");

  assert.equal(cursors.hermes.native, undefined, "native key should be removed");
  assert.equal(cursors.hermes.wsl, undefined, "wsl key should be removed");
  assert.equal(cursors.hermes.lastCompletedStartedAt, 50, "native value should win on conflict");
});

test("ensureFlatCursor no-ops on already-flat cursor", () => {
  const cursors = {
    hermes: { lastCompletedStartedAt: 50, snapshots: {} },
  };

  ensureFlatCursor(cursors, "hermes");

  assert.equal(cursors.hermes.lastCompletedStartedAt, 50);
});

test("dual-parse after migration maintains independent namespace state", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-migrate-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  const cursors = {
    hourly: { buckets: {} },
    hermes: { lastCompletedStartedAt: 100, unfinishedSessionIds: ["old"], snapshots: {} },
  };

  const r = await multiInstallParse({
    paths: { native: "/native-hermes", wsl: "/wsl-hermes" },
    parserFn: async ({ cursors: c }) => {
      c.hermes = c.hermes || {};
      c.hermes.lastRun = c.hermes.lastRun || 0;
      c.hermes.lastRun += 1;
      c.hermes.unfinishedSessionIds = c.hermes.unfinishedSessionIds || [];
      c.hermes.unfinishedSessionIds.push(`session-${Date.now()}`);
      return { recordsProcessed: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (p) => ({ hermesPath: p }),
    queuePath,
  });

  assert.equal(r.recordsProcessed, 2, "both installs should parse");
  assert.ok(cursors.hermes.native, "native namespace exists");
  assert.ok(cursors.hermes.wsl, "wsl namespace exists");
  assert.ok(cursors.hermes.native.lastRun >= 1);
  assert.ok(cursors.hermes.wsl.lastRun >= 1);
  assert.ok(cursors.hermes.native.lastCompletedStartedAt === 100,
    "flat cursor data survived migration in native");
  assert.ok(cursors.hermes.wsl.lastCompletedStartedAt === 100,
    "flat cursor data survived migration in wsl");
});
