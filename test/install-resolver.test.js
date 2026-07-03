const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { mockPlatform } = require("./helpers/mock");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { resolveInstallPaths, ensureNamespacedCursors } = require("../src/lib/install-resolver");
const wsl = require("../src/lib/wsl-probe");

// ── resolveInstallPaths ───────────────────────────────────────────────────────

test("resolveInstallPaths returns single path on non-Windows", () => {
  const r = resolveInstallPaths("hermes", { nativeValue: "/home/user/.hermes", wslDir: ".hermes" }, {}, {});
  assert.equal(r.native, "/home/user/.hermes");
  assert.equal(r.wsl, null);
});

test("resolveInstallPaths both mode returns both paths when both exist on Windows", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-test-both-"));
  try {
    const nativeDir = path.join(tmpDir, "native");
    const wslDir = path.join(tmpDir, "wsl");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.mkdirSync(wslDir, { recursive: true });

    const r = resolveInstallPaths("hermes",
      { nativeValue: nativeDir, wslValue: wslDir },
      { TOKENTRACKER_WSL_MODE: "both" },
      { runWsl: () => "Ubuntu\n", existsSync: () => true },
    );
    assert.equal(r.native, nativeDir);
    assert.equal(r.wsl, wslDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveInstallPaths both mode single-install fallback", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-test-single-"));
  try {
    const nativeDir = path.join(tmpDir, "native");
    fs.mkdirSync(nativeDir, { recursive: true });

    const r = resolveInstallPaths("hermes",
      { nativeValue: nativeDir, wslValue: null },
      { TOKENTRACKER_WSL_MODE: "both" },
      { runWsl: () => "Ubuntu\n", existsSync: () => false },
    );
    assert.equal(r.native, nativeDir);
    assert.equal(r.wsl, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveInstallPaths non-both modes return single path", (t) => {
  mockPlatform(t, "win32");
  for (const mode of ["wsl-first", "native-first", "wsl-only", "native-only", undefined]) {
    const env = mode ? { TOKENTRACKER_WSL_MODE: mode } : {};
    const r = resolveInstallPaths("hermes",
      { nativeValue: "C:\\native", wslValue: "\\\\wsl$\\path" },
      env,
      { runWsl: () => "Ubuntu\n", existsSync: () => true },
    );
    assert.equal(r.wsl, null, `mode=${mode} should have wsl=null`);
    assert.ok(typeof r.native === "string" || r.native === null, `mode=${mode} native should be string or null`);
  }
});

// ── ensureNamespacedCursors ───────────────────────────────────────────────────

test("ensureNamespacedCursors transparent for already-namespaced cursors", () => {
  const cursors = {
    hermes: {
      native: { lastCompletedStartedAt: 100 },
      wsl: { lastCompletedStartedAt: 0 },
    },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.equal(ns, cursors.hermes);
  assert.equal(ns.native.lastCompletedStartedAt, 100);
  assert.equal(ns.wsl.lastCompletedStartedAt, 0);
});

test("ensureNamespacedCursors migrates flat cursor to both namespaces", () => {
  const cursors = {
    hermes: { lastCompletedStartedAt: 100, unfinishedSessionIds: ["abc"] },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.equal(ns.native.lastCompletedStartedAt, 100);
  assert.deepEqual(ns.native.unfinishedSessionIds, ["abc"]);
  assert.equal(ns.wsl.lastCompletedStartedAt, 100, "WSL namespace should also have the flat data");
  assert.deepEqual(ns.wsl.unfinishedSessionIds, ["abc"]);
  assert.ok(ns === cursors.hermes, "cursors.hermes should be replaced with namespace object");
});

test("ensureNamespacedCursors handles empty provider state", () => {
  const cursors = {};
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.deepEqual(ns.native, {});
  assert.deepEqual(ns.wsl, {});
});

// ── wsl-probe: both mode and getWslPrefer ─────────────────────────────────────

test("getWslMode recognizes both mode", () => {
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: "both" }), "both");
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: "BOTH" }), "both");
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: " Both " }), "both");
});

test("isInvalidWslMode accepts both mode", () => {
  assert.equal(wsl.isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "both" }), false);
});

test("getWslPrefer returns null when unset, respects explicit setting", () => {
  assert.equal(wsl.getWslPrefer({}), null);
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "" }), null);
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "wsl" }), "wsl");
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "native" }), "native");
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "WSL" }), "wsl");
});

test("getWslPrefer invalid values return null", () => {
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "foo" }), null);
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "both" }), null);
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "wsl-first" }), null);
  assert.equal(wsl.getWslPrefer({ TOKENTRACKER_WSL_PREFER: "native_first" }), null);
});

test("pickWin32Path handles both mode", (t) => {
  mockPlatform(t, "win32");
  const r = wsl.pickWin32Path({
    wslValue: "\\\\wsl$\\path",
    nativeValue: "C:\\native",
    env: { TOKENTRACKER_WSL_MODE: "both" },
    platform: "win32",
  });
  assert.equal(r, "\\\\wsl$\\path", "both mode should prefer WSL for pickWin32Path");
});

test("resolveAllWin32Paths returns both paths in both mode", (t) => {
  mockPlatform(t, "win32");
  const r = wsl.resolveAllWin32Paths({
    wslValue: "\\\\wsl$\\path",
    nativeValue: "C:\\native",
    env: { TOKENTRACKER_WSL_MODE: "both" },
    platform: "win32",
  });
  assert.equal(r.native, "C:\\native");
  assert.equal(r.wsl, "\\\\wsl$\\path");
});

test("resolveAllWin32Paths returns single path in non-both mode", (t) => {
  mockPlatform(t, "win32");
  const r = wsl.resolveAllWin32Paths({
    wslValue: "\\\\wsl$\\path",
    nativeValue: "C:\\native",
    env: {},
    platform: "win32",
  });
  assert.equal(r.native, "\\\\wsl$\\path");
  assert.equal(r.wsl, null);
});
