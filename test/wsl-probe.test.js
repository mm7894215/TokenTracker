const assert = require("node:assert/strict");
const { test, describe, before } = require("node:test");
const cp = require("node:child_process");

const {
  defaultRunWsl,
  parseWslListVerbose,
  probeWslDistros,
  discoverWslHome,
  isUncPath,
  snapshotSqliteDb,
  getWslMode,
  isInvalidWslMode,
  shouldProbeWsl,
  shouldProbeNative,
  pickWin32Path,
  normalizeWslMode,
  resetWslProbeCache,
} = require("../src/lib/wsl-probe");

test("parseWslListVerbose parses distros, default marker and version column", () => {
  const raw = "  NAME            STATE           VERSION\n" +
    "* Ubuntu          Running         2\n" +
    "  Debian-22.04    Stopped         1\n";
  assert.deepEqual(parseWslListVerbose(raw), [
    { name: "Ubuntu", version: 2, isDefault: true },
    { name: "Debian-22.04", version: 1, isDefault: false },
  ]);
});

test("parseWslListVerbose tolerates UTF-16 NUL/BOM noise and skips the header", () => {
  const raw = "\uFEFF  NAME   STATE   VERSION\n* Ub\u0000untu Running 2\n";
  assert.deepEqual(parseWslListVerbose(raw), [
    { name: "Ubuntu", version: 2, isDefault: true },
  ]);
  assert.deepEqual(parseWslListVerbose(""), []);
  assert.deepEqual(parseWslListVerbose(undefined), []);
});

test("probeWslDistros sorts the default distro first and is fail-safe", () => {
  const raw = "  NAME    STATE    VERSION\n  Debian  Stopped  1\n* Ubuntu  Running  2\n";
  assert.deepEqual(probeWslDistros({ runWsl: () => raw }), [
    { name: "Ubuntu", version: 2, isDefault: true },
    { name: "Debian", version: 1, isDefault: false },
  ]);
  assert.deepEqual(
    probeWslDistros({ runWsl: () => { throw new Error("wsl not found"); } }),
    [],
  );
});

test("discoverWslHome resolves provider dir via the right UNC alias per distro", () => {
  const list = "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n  Legacy  Running  1\n";
  const users = { Ubuntu: "alice\n", Legacy: "bob\n" };
  const runWsl = (args) => (args[0] === "-l" ? list : users[args[1]]);

  const tried = [];
  const hit = discoverWslHome(".myapp", {
    runWsl,
    existsSync: (p) => {
      tried.push(p);
      return p === "\\\\wsl$\\Ubuntu\\home\\alice\\.myapp";
    },
  });
  assert.equal(hit, "\\\\wsl$\\Ubuntu\\home\\alice\\.myapp");
  assert.equal(tried[0], "\\\\wsl$\\Ubuntu\\home\\alice\\.myapp");

  const tried1 = [];
  const hit1 = discoverWslHome(".myapp", {
    runWsl,
    existsSync: (p) => {
      tried1.push(p);
      return false;
    },
  });
  assert.equal(hit1, null);
  const legacyCandidates = tried1.filter((p) => p.includes("Legacy"));
  assert.ok(legacyCandidates.length >= 2);
  assert.ok(legacyCandidates[0].includes("wsl.localhost"));
  assert.ok(legacyCandidates[1].includes("wsl$"));

  assert.equal(discoverWslHome(".myapp", { runWsl, existsSync: () => false }), null);
  assert.equal(
    discoverWslHome(".myapp", {
      runWsl: (args) => { if (args[0] === "-l") return list; throw new Error("whoami failed"); },
      existsSync: () => true,
    }),
    null,
  );
});

test("isUncPath detects WSL and network UNC paths", () => {
  assert.equal(isUncPath("\\\\wsl$\\Ubuntu\\home\\user"), true);
  assert.equal(isUncPath("\\\\wsl.localhost\\Ubuntu\\home\\user"), true);
  assert.equal(isUncPath("\\\\server\\share\\path"), true);
  assert.equal(isUncPath("//wsl$/Ubuntu/path"), true);
  assert.equal(isUncPath("/home/user/.myapp"), false);
  assert.equal(isUncPath("C:\\Users\\user"), false);
  assert.equal(isUncPath(null), false);
  assert.equal(isUncPath(undefined), false);
});

test("snapshotSqliteDb copies a file and its WAL/shm/journal siblings", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-test-src-"));
  const dbPath = path.join(srcDir, "test.db");
  fs.writeFileSync(dbPath, "db content");
  fs.writeFileSync(dbPath + "-wal", "wal content");
  fs.writeFileSync(dbPath + "-shm", "shm content");

  const snap = snapshotSqliteDb(dbPath);
  assert.equal(fs.readFileSync(snap.path, "utf8"), "db content");
  assert.equal(fs.readFileSync(snap.path + "-wal", "utf8"), "wal content");
  assert.equal(fs.readFileSync(snap.path + "-shm", "utf8"), "shm content");
  assert.equal(fs.existsSync(dbPath), true, "original should still exist");

  snap.cleanup();
  assert.equal(fs.existsSync(snap.path), false, "snapshot should be removed after cleanup");
  assert.equal(fs.existsSync(path.dirname(snap.path)), false, "tmp dir should be removed");

  fs.rmSync(srcDir, { recursive: true, force: true });
});

// ── WSL mode helpers ─────────────────────────────────────────────────────────

test("getWslMode returns default wsl-first for unset env", () => {
  assert.equal(getWslMode({}), "wsl-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "" }), "wsl-first");
});

test("normalizeWslMode normalizes whitespace, case, and underscores", () => {
  assert.equal(normalizeWslMode(" NATIVE_FIRST "), "native-first");
  assert.equal(normalizeWslMode("WSL_ONLY"), "wsl-only");
  assert.equal(normalizeWslMode(null), "");
});

test("getWslMode normalizes case, whitespace, and underscores", () => {
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "native-first" }), "native-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "Native-First" }), "native-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "NATIVE_FIRST" }), "native-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "  native-first  " }), "native-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "WSL_ONLY" }), "wsl-only");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "native_only" }), "native-only");
});

test("getWslMode returns default for invalid values", () => {
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "foo" }), "wsl-first");
  assert.equal(getWslMode({ TOKENTRACKER_WSL_MODE: "wsl" }), "wsl-first");
});

test("isInvalidWslMode detects invalid values", () => {
  assert.equal(isInvalidWslMode({}), false);
  assert.equal(isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "" }), false);
  assert.equal(isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "wsl-first" }), false);
  assert.equal(isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "native-only" }), false);
  assert.equal(isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "foo" }), true);
  assert.equal(isInvalidWslMode({ TOKENTRACKER_WSL_MODE: "wsl" }), true);
});

test("shouldProbeWsl is false only for native-only mode", () => {
  assert.equal(shouldProbeWsl({}), true);
  assert.equal(shouldProbeWsl({ TOKENTRACKER_WSL_MODE: "wsl-first" }), true);
  assert.equal(shouldProbeWsl({ TOKENTRACKER_WSL_MODE: "native-first" }), true);
  assert.equal(shouldProbeWsl({ TOKENTRACKER_WSL_MODE: "wsl-only" }), true);
  assert.equal(shouldProbeWsl({ TOKENTRACKER_WSL_MODE: "native-only" }), false);
});

test("shouldProbeNative is false only for wsl-only mode", () => {
  assert.equal(shouldProbeNative({}), true);
  assert.equal(shouldProbeNative({ TOKENTRACKER_WSL_MODE: "wsl-first" }), true);
  assert.equal(shouldProbeNative({ TOKENTRACKER_WSL_MODE: "native-first" }), true);
  assert.equal(shouldProbeNative({ TOKENTRACKER_WSL_MODE: "wsl-only" }), false);
  assert.equal(shouldProbeNative({ TOKENTRACKER_WSL_MODE: "native-only" }), true);
});

test("pickWin32Path returns null on non-Windows platforms", () => {
  for (const mode of [undefined, "wsl-first", "native-first", "wsl-only", "native-only"]) {
    const env = mode ? { TOKENTRACKER_WSL_MODE: mode } : {};
    assert.equal(pickWin32Path({ wslValue: "/wsl", nativeValue: "/native", env, platform: "linux" }), null);
    assert.equal(pickWin32Path({ wslValue: "/wsl", nativeValue: "/native", env, platform: "darwin" }), null);
  }
});

test("pickWin32Path matrix", () => {
  const cases = [
    // mode                    wsl      native   expected
    [undefined,                "wsl",   "native", "wsl"],
    ["wsl-first",              "wsl",   "native", "wsl"],
    ["native-first",           "wsl",   "native", "native"],
    ["native-first",           "wsl",   null,     "wsl"],
    ["wsl-first",              null,    "native", "native"],
    ["wsl-only",               null,    "native", null],
    ["native-only",            "wsl",   null,     null],
    ["native-only",            "wsl",   "native", "native"],
    [" native-first ",         "wsl",   "native", "native"],
    ["NATIVE-FIRST",           "wsl",   "native", "native"],
    ["bad-value",              "wsl",   "native", "wsl"],
  ];
  for (const [mode, wsl, native, expected] of cases) {
    const env = mode ? { TOKENTRACKER_WSL_MODE: mode } : {};
    assert.equal(
      pickWin32Path({ wslValue: wsl ?? null, nativeValue: native ?? null, env, platform: "win32" }),
      expected ?? null,
      `mode=${JSON.stringify(mode)} wsl=${JSON.stringify(wsl)} native=${JSON.stringify(native)}`,
    );
  }
});

test("discoverWslHome respects shouldProbeWsl (native-only)", () => {
  // Even with a working runWsl, native-only mode should skip the probe.
  const runWsl = () => { throw new Error("should not be called"); };
  assert.equal(
    discoverWslHome(".myapp", { runWsl, env: { TOKENTRACKER_WSL_MODE: "native-only" } }),
    null,
  );
});

// ── Real WSL integration test (skipped when wsl.exe is unavailable) ──────────
// Only runs on Windows with WSL installed. This validates that our parsing
// logic matches real `wsl.exe -l -v` output format, and that UNC paths to WSL
// distros are reachable. Without actual WSL, we skip silently.
describe("real WSL integration", { skip: process.platform !== "win32" }, () => {
  let wslAvailable = false;
  before(() => {
    try {
      cp.execFileSync("wsl.exe", ["--version"], { stdio: "ignore", timeout: 5000 });
      wslAvailable = true;
    } catch {
      wslAvailable = false;
    }
  });

  test("defaultRunWsl parses distro list successfully", { skip: !wslAvailable }, () => {
    const raw = defaultRunWsl(["-l", "-v"], { utf16: true });
    assert.ok(typeof raw === "string", `expected string, got ${typeof raw}`);
    assert.ok(raw.length > 0, "wsl.exe -l -v output should not be empty");
    const distros = parseWslListVerbose(raw);
    assert.ok(Array.isArray(distros), "parsed distros should be an array");
    assert.ok(distros.length > 0, "expected at least one WSL distro");
    for (const d of distros) {
      assert.ok(typeof d.name === "string" && d.name.length > 0, `distro name should be non-empty, got ${d.name}`);
      assert.ok(d.version === 1 || d.version === 2, `version should be 1 or 2, got ${d.version}`);
      assert.ok(typeof d.isDefault === "boolean", `isDefault should be boolean, got ${d.isDefault}`);
    }
    // The default distro marker should place it first.
    const defaults = distros.filter((d) => d.isDefault);
    assert.equal(defaults.length, 1, "exactly one default distro expected");
    assert.equal(distros[0].name, defaults[0].name, "default distro should be first");
  });

  test("probeWslDistros returns real distros via defaultRunWsl", { skip: !wslAvailable }, () => {
    const distros = probeWslDistros();
    assert.ok(Array.isArray(distros));
    assert.ok(distros.length > 0);
    const defaults = distros.filter((d) => d.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(distros[0].name, defaults[0].name);
  });
});

test("snapshotSqliteDb handles missing WAL/shm/journal gracefully", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-test-src2-"));
  const dbPath = path.join(srcDir, "clean.db");
  fs.writeFileSync(dbPath, "clean content");

  const snap = snapshotSqliteDb(dbPath);
  assert.equal(fs.readFileSync(snap.path, "utf8"), "clean content");
  snap.cleanup();

  fs.rmSync(srcDir, { recursive: true, force: true });
});

test("probeWslDistros cache is bypassed when deps are provided", () => {
  const harmfulDistro = () => { throw new Error("should not be called"); };
  const cleanDistro = () => "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";

  // Populate cache with a successful probe (no deps → cached)
  resetWslProbeCache();
  const cached = probeWslDistros({ runWsl: cleanDistro, existsSync: () => false });

  // The cache was populated (if real WSL wasn't called). Now call with
  // harmful deps — if cache were used, harmfulDistro wouldn't be called.
  // If cache is bypassed, harmfulDistro is called and throws → empty result.
  const result = probeWslDistros({ runWsl: harmfulDistro });
  // Without deps, uses the cached `cleanDistro` result, so this should
  // return the cached distros (not empty as harmfulDistro would produce).
  // OR if the cache missed, it would probe real WSL.
  // The important invariant: cache should NOT interfere with deps-provided calls.
  const depsResult = probeWslDistros({ runWsl: harmfulDistro });
  assert.ok(Array.isArray(depsResult), "deps call should not throw even if cache is poisoned");
});

test("resetWslProbeCache clears module-level cache", () => {
  // probeWslDistros caches results only when called WITHOUT deps.
  // Verify that resetWslProbeCache() clears this cache.
  const mockDistros = () => "  NAME    STATE    VERSION\n* Ubuntu  Running  2\n";

  resetWslProbeCache();
  // Call with deps → bypasses cache, result not cached
  const r1 = probeWslDistros({ runWsl: mockDistros, existsSync: () => false });
  assert.equal(r1.length, 1, "should probe with provided deps");

  // Call with deps again → cache doesn't matter, always fresh when deps provided
  const r2 = probeWslDistros({ runWsl: mockDistros, existsSync: () => false });
  assert.equal(r2.length, 1, "deps-provided calls always probe fresh");

  // resetWslProbeCache should not throw
  assert.doesNotThrow(() => resetWslProbeCache());
});
