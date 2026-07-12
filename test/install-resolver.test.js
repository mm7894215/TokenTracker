const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { mockPlatform } = require("./helpers/mock");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { resolveInstallPaths, ensureNamespacedCursors } = require("../src/lib/install-resolver");
const wsl = require("../src/lib/wsl-probe");

// ── resolveInstallPaths ───────────────────────────────────────────────────────

test("resolveInstallPaths returns single path on non-Windows", (t) => {
  mockPlatform(t, "linux");
  const r = resolveInstallPaths({ nativeValue: "/home/user/.hermes", wslDir: ".hermes" }, {}, {});
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

    const r = resolveInstallPaths(
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

    const r = resolveInstallPaths(
      { nativeValue: nativeDir, wslValue: null },
      { TOKENTRACKER_WSL_MODE: "both" },
      { runWsl: () => "Ubuntu\n", existsSync: (p) => p === nativeDir },
    );
    assert.equal(r.native, nativeDir);
    assert.equal(r.wsl, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveInstallPaths non-both modes return single path with correct selection", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-mode-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });
  // Put a marker file in native so we can identify which path was selected
  fs.writeFileSync(path.join(nativeDir, ".native-marker"), "");
  fs.writeFileSync(path.join(wslDir, ".wsl-marker"), "");

  const cases = [
    { mode: "wsl-first",    expected: wslDir },
    { mode: "native-first", expected: nativeDir },
    { mode: "wsl-only",     expected: wslDir },
    { mode: "native-only",  expected: nativeDir },
    { mode: undefined,      expected: wslDir },
  ];
  for (const { mode, expected } of cases) {
    const env = mode ? { TOKENTRACKER_WSL_MODE: mode } : {};
    const r = resolveInstallPaths(
      { nativeValue: nativeDir, wslValue: wslDir },
      env,
      { runWsl: () => "Ubuntu\n", existsSync: () => true },
    );
    assert.equal(r.wsl, null, `mode=${mode} should have wsl=null`);
    assert.equal(r.native, expected, `mode=${mode} should select ${expected}`);
  }
});

test("resolveInstallPaths wsl-first falls back to native when WSL DB is missing but native exists", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-wsl-fallback-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDb = path.join(tmpDir, "native.db");
  const wslDb = path.join(tmpDir, "wsl.db");

  // Create native DB only, leave WSL DB missing
  fs.writeFileSync(nativeDb, "fake-db");

  const r = resolveInstallPaths(
    { nativeValue: nativeDb, wslValue: wslDb },
    { TOKENTRACKER_WSL_MODE: "wsl-first" },
    { runWsl: () => "Ubuntu\n" }
  );
  assert.equal(r.wsl, null);
  assert.equal(r.native, nativeDb);
});

// ── Provider path resolution (PR #261) ────────────────────────────────────────

test("kilo-cli native path defaults to XDG on Linux, APPDATA on Windows", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const r = resolveInstallPaths(
    { nativeValue: path.join(home, ".local", "share", "kilo", "kilo.db") },
    {},
    {},
  );
  assert.equal(r.native, path.join(home, ".local", "share", "kilo", "kilo.db"));
  assert.equal(r.wsl, null);
});

test("kilo-cli WSL path resolves on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-kilo-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
});

test("mimo native path defaults to XDG on Linux, APPDATA on Windows", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const r = resolveInstallPaths(
    { nativeValue: path.join(home, ".local", "share", "mimocode", "mimocode.db") },
    {},
    {},
  );
  assert.equal(r.native, path.join(home, ".local", "share", "mimocode", "mimocode.db"));
  assert.equal(r.wsl, null);
});

test("mimo WSL path resolves on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-mimo-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
});

test("zcode native path defaults to HOME on Linux, APPDATA on Windows", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const r = resolveInstallPaths(
    { nativeValue: path.join(home, ".zcode", "cli", "db", "db.sqlite") },
    {},
    {},
  );
  assert.equal(r.native, path.join(home, ".zcode", "cli", "db", "db.sqlite"));
  assert.equal(r.wsl, null);
});

test("zcode WSL path resolves on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-zcode-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
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

test("ensureNamespacedCursors default seeds every namespace (no ownership evidence)", () => {
  const cursors = {
    hermes: { lastCompletedStartedAt: 100, unfinishedSessionIds: ["abc"] },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.equal(ns.native.lastCompletedStartedAt, 100, "native seeded with flat data");
  assert.deepEqual(ns.native.unfinishedSessionIds, ["abc"]);
  assert.equal(ns.wsl.lastCompletedStartedAt, 100, "wsl seeded with flat data");
  assert.deepEqual(ns.wsl.unfinishedSessionIds, ["abc"]);
  assert.notEqual(ns.native, ns.wsl, "namespaces are independent copies");
  ns.wsl.unfinishedSessionIds.push("wsl-only");
  assert.deepEqual(ns.native.unfinishedSessionIds, ["abc"], "deep copies do not alias");
  assert.ok(ns === cursors.hermes, "cursors.hermes should be replaced with namespace object");
});

test("ensureNamespacedCursors seeds only the proven active namespace", () => {
  const cursors = {
    hermes: { lastCompletedStartedAt: 100, unfinishedSessionIds: ["abc"] },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes", ["wsl"]);
  assert.equal(ns.native.lastCompletedStartedAt, undefined, "non-active namespace starts empty");
  assert.equal(ns.native.unfinishedSessionIds, undefined, "non-active namespace starts empty");
  assert.equal(ns.wsl.lastCompletedStartedAt, 100, "active namespace gets flat data");
  assert.deepEqual(ns.wsl.unfinishedSessionIds, ["abc"]);
});

test("ensureNamespacedCursors accepts a bare string activeKey", () => {
  const cursors = {
    hermes: { lastCompletedStartedAt: 100 },
  };
  const ns = ensureNamespacedCursors(cursors, "hermes", "native");
  assert.equal(ns.native.lastCompletedStartedAt, 100);
  assert.equal(ns.wsl.lastCompletedStartedAt, undefined);
});

test("ensureNamespacedCursors handles empty provider state", () => {
  const cursors = {};
  const ns = ensureNamespacedCursors(cursors, "hermes");
  assert.deepEqual(ns.native, {});
  assert.deepEqual(ns.wsl, {});
});

// ── wsl-probe: both mode ──────────────────────────────────────────────────────

test("getWslMode recognizes both mode", () => {
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: "both" }), "both");
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: "BOTH" }), "both");
  assert.equal(wsl.getWslMode({ TOKENTRACKER_WSL_MODE: " Both " }), "both");
});

test("isInvalidWslMode accepts both mode", () => {
  assert.equal(wsl.isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "both" }), false);
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

// ── Every Code path resolution (PR #261) ──────────────────────────────────────

test("every-code native path defaults to HOME on all platforms", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const r = resolveInstallPaths(
    { nativeValue: path.join(home, ".code") },
    {},
    {},
  );
  assert.equal(r.native, path.join(home, ".code"));
  assert.equal(r.wsl, null);
});

test("every-code WSL path resolves on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-everycode-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
});

// ── Gemini CLI & Antigravity path resolution (PR #261) ────────────────────────

test("gemini/antigravity native path defaults to HOME on all platforms", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const r = resolveInstallPaths(
    { nativeValue: path.join(home, ".gemini") },
    {},
    {},
  );
  assert.equal(r.native, path.join(home, ".gemini"));
  assert.equal(r.wsl, null);
});

test("gemini/antigravity WSL path resolves on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-gemini-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
});

// ── Codex CLI & OpenCode path resolution (PR #261) ────────────────────────────

test("codex/opencode native paths default correctly", (t) => {
  mockPlatform(t, "linux");
  const home = "/home/user";
  const rCodex = resolveInstallPaths(
    { nativeValue: path.join(home, ".codex") },
    {},
    {},
  );
  assert.equal(rCodex.native, path.join(home, ".codex"));
  assert.equal(rCodex.wsl, null);

  const rOpencode = resolveInstallPaths(
    { nativeValue: path.join(home, ".local", "share", "opencode") },
    {},
    {},
  );
  assert.equal(rOpencode.native, path.join(home, ".local", "share", "opencode"));
  assert.equal(rOpencode.wsl, null);
});

test("codex/opencode WSL paths resolve on Windows both mode", (t) => {
  mockPlatform(t, "win32");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-opencode-wsl-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const nativeDir = path.join(tmpDir, "native");
  const wslDir = path.join(tmpDir, "wsl");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });

  const r = resolveInstallPaths(
    { nativeValue: nativeDir, wslValue: wslDir },
    { TOKENTRACKER_WSL_MODE: "both" },
    { runWsl: () => "Ubuntu\n", existsSync: () => true },
  );
  assert.equal(r.native, nativeDir);
  assert.equal(r.wsl, wslDir);
});

test("opencode paths union correctly combines storage and db paths", () => {
  const storagePaths = { native: "/storage/native", wsl: null };
  const dbPaths = { native: null, wsl: "/db/wsl" };
  const opencodePaths = {
    native: storagePaths.native || dbPaths.native,
    wsl: storagePaths.wsl || dbPaths.wsl,
  };
  assert.equal(opencodePaths.native, "/storage/native");
  assert.equal(opencodePaths.wsl, "/db/wsl");
});
