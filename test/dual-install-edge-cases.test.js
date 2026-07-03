const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { resolveInstallPaths, ensureNamespacedCursors } = require("../src/lib/install-resolver");
const { getWslMode, getWslPrefer, resetWslProbeCache } = require("../src/lib/wsl-probe");
const { multiInstallParse, emptyResult } = require("../src/lib/multi-install-parser");
const { mockPlatform } = require("./helpers/mock");

test("edge: WSL probe failure in both mode falls back gracefully", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-wsl-fail-"));
  try {
    const nativeDir = path.join(tmpDir, "native");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "state.db"), "fake db");

    const r = resolveInstallPaths("hermes",
      { nativeValue: nativeDir, wslValue: null },
      { TOKENTRACKER_WSL_MODE: "both" },
      { runWsl: () => { throw new Error("wsl not found"); }, existsSync: () => false },
    );
    assert.equal(r.native, nativeDir);
    assert.equal(r.wsl, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("edge: both mode with single native install produces same result as non-both", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-single-"));
  try {
    const nativeDir = path.join(tmpDir, "native");
    fs.mkdirSync(nativeDir, { recursive: true });

    const bothResult = resolveInstallPaths("hermes",
      { nativeValue: nativeDir, wslValue: null },
      { TOKENTRACKER_WSL_MODE: "both" },
      { runWsl: () => { throw new Error("no wsl"); }, existsSync: () => false },
    );

    const wslFirstResult = resolveInstallPaths("hermes",
      { nativeValue: nativeDir, wslValue: null },
      { TOKENTRACKER_WSL_MODE: "wsl-first" },
      { runWsl: () => { throw new Error("no wsl"); }, existsSync: () => false },
    );

    assert.equal(bothResult.native, nativeDir);
    assert.equal(bothResult.wsl, null);
    assert.equal(wslFirstResult.native, nativeDir);
    assert.equal(wslFirstResult.wsl, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("edge: ensureNamespacedCursors handles mixed native+wsl state", () => {
  const cursors = {
    hermes: {
      native: { lastCompletedStartedAt: 50, unfinishedSessionIds: ["a"], snapshots: {} },
      wsl: { lastCompletedStartedAt: 10, unfinishedSessionIds: ["b"], snapshots: {} },
    },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.equal(ns.native.lastCompletedStartedAt, 50);
  assert.equal(ns.wsl.lastCompletedStartedAt, 10);
  assert.deepEqual(ns.native.unfinishedSessionIds, ["a"]);
  assert.deepEqual(ns.wsl.unfinishedSessionIds, ["b"]);
});

test("edge: multiInstallParse handles WSL probe timeout graceful skip", async () => {
  const cursors = { hourly: {} };
  const r = await multiInstallParse({
    paths: { native: "/native", wsl: null },
    parserFn: async ({ cursors: c }) => {
      c.hermes = { ok: true };
      return { recordsProcessed: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ hermesPath: path }),
  });
  assert.equal(r.recordsProcessed, 1);
});

test("edge: WSL_PREFER is null when unset, native/wsl when set", () => {
  assert.equal(getWslPrefer({}), null);
  assert.equal(getWslPrefer({ TOKENTRACKER_WSL_PREFER: "wsl" }), "wsl");
  assert.equal(getWslPrefer({ TOKENTRACKER_WSL_PREFER: "native" }), "native");
});

test("edge: resetWslProbeCache cleans shared state", () => {
  resetWslProbeCache();
  assert.doesNotThrow(() => resetWslProbeCache());
});
