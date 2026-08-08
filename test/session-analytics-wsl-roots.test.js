/**
 * Session-analytics WSL multi-root discovery.
 *
 * The sessions pipeline built its Claude/Codex roots from the native home
 * only, so on a Windows host with a WSL install the session browser, its
 * project list, and the `tracker sessions` export showed native sessions
 * exclusively -- while sync (src/commands/sync.js) already walked both Claude
 * homes, leaving the same work counted in token totals but absent here.
 *
 * Verifies:
 *   - win32 + a discoverable WSL home yields both roots
 *   - TOKENTRACKER_WSL_MODE gates each side (native-only / wsl-only / both)
 *   - a WSL home that does not resolve degrades to native only
 *   - non-win32 never probes WSL
 *   - an injected home (tests, custom HOME) never picks up the machine's real
 *     WSL sessions -- discoverWslHome resolves \\wsl$ independently of `home`,
 *     so without this guard a fixture home silently inherits live WSL data
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { providerRoots } = require("../src/lib/session-analytics");

const REAL_HOME = "C:\\Users\\dev";
const WSL_HOME = "\\\\wsl$\\Ubuntu\\home\\dev\\.claude";

// Stand-in for the real machine: `home` is the native home, and the WSL probe
// resolves. deps keep the probe off the host running the suite.
function win32Deps({ wslRoot = WSL_HOME, homedir = REAL_HOME } = {}) {
  return {
    platform: "win32",
    homedir: () => homedir,
    discoverWslHome: () => wslRoot,
  };
}

test("win32 with a discoverable WSL home returns native + WSL roots", () => {
  const roots = providerRoots(REAL_HOME, ".claude", { TOKENTRACKER_WSL_MODE: "both" }, win32Deps());
  assert.deepEqual(roots, [path.join(REAL_HOME, ".claude"), WSL_HOME]);
});

test("default mode (wsl-first) still probes both sides", () => {
  // wsl-first only changes precedence for single-install resolution; discovery
  // is additive, so an unset mode must not drop the WSL root.
  const roots = providerRoots(REAL_HOME, ".claude", {}, win32Deps());
  assert.equal(roots.length, 2);
  assert.ok(roots.includes(WSL_HOME));
});

test("native-only omits the WSL root", () => {
  const roots = providerRoots(REAL_HOME, ".claude", { TOKENTRACKER_WSL_MODE: "native-only" }, win32Deps());
  assert.deepEqual(roots, [path.join(REAL_HOME, ".claude")]);
});

test("wsl-only omits the native root", () => {
  const roots = providerRoots(REAL_HOME, ".claude", { TOKENTRACKER_WSL_MODE: "wsl-only" }, win32Deps());
  assert.deepEqual(roots, [WSL_HOME]);
});

test("an unresolvable WSL home degrades to native only", () => {
  const roots = providerRoots(
    REAL_HOME,
    ".claude",
    { TOKENTRACKER_WSL_MODE: "both" },
    win32Deps({ wslRoot: null }),
  );
  assert.deepEqual(roots, [path.join(REAL_HOME, ".claude")]);
});

test("non-win32 never probes WSL", () => {
  let probed = false;
  const roots = providerRoots("/home/dev", ".claude", { TOKENTRACKER_WSL_MODE: "both" }, {
    platform: "linux",
    homedir: () => "/home/dev",
    discoverWslHome: () => { probed = true; return "/should/not/be/used"; },
  });
  assert.deepEqual(roots, [path.join("/home/dev", ".claude")]);
  assert.equal(probed, false);
});

test("an injected home never inherits the machine's real WSL sessions", () => {
  // buildSessionAnalytics({ home }) is how the suite and a custom HOME reach
  // this path. discoverWslHome ignores `home`, so probing on a fixture home
  // would splice live WSL transcripts into an isolated temp dir.
  let probed = false;
  const fixtureHome = "C:\\Temp\\tt-fixture-home";
  const roots = providerRoots(fixtureHome, ".claude", { TOKENTRACKER_WSL_MODE: "both" }, {
    platform: "win32",
    homedir: () => REAL_HOME,
    discoverWslHome: () => { probed = true; return WSL_HOME; },
  });
  assert.deepEqual(roots, [path.join(fixtureHome, ".claude")]);
  assert.equal(probed, false, "WSL must not be probed for a home that is not os.homedir()");
});

// The default is a heuristic ("is this the machine's own home?"), so the
// escape hatch has to be reachable and pinned: a caller that deliberately
// scans a non-default tree must be able to keep WSL discovery, and one
// scanning the real home must be able to turn it off. Without these, a future
// refactor threading a custom home would lose WSL roots with nothing failing.
test("probeWsl:true opts a non-default home back into WSL discovery", () => {
  const roots = providerRoots("C:\\Temp\\other-profile", ".claude", { TOKENTRACKER_WSL_MODE: "both" }, {
    platform: "win32",
    homedir: () => REAL_HOME,
    discoverWslHome: () => WSL_HOME,
    probeWsl: true,
  });
  assert.deepEqual(roots, [path.join("C:\\Temp\\other-profile", ".claude"), WSL_HOME]);
});

test("probeWsl:false opts the real home out of WSL discovery", () => {
  let probed = false;
  const roots = providerRoots(REAL_HOME, ".claude", { TOKENTRACKER_WSL_MODE: "both" }, {
    platform: "win32",
    homedir: () => REAL_HOME,
    discoverWslHome: () => { probed = true; return WSL_HOME; },
    probeWsl: false,
  });
  assert.deepEqual(roots, [path.join(REAL_HOME, ".claude")]);
  assert.equal(probed, false);
});

test("codex roots resolve independently of claude roots", () => {
  const deps = {
    platform: "win32",
    homedir: () => REAL_HOME,
    discoverWslHome: (providerDir) => `\\\\wsl$\\Ubuntu\\home\\dev\\${providerDir}`,
  };
  const roots = providerRoots(REAL_HOME, ".codex", { TOKENTRACKER_WSL_MODE: "both" }, deps);
  assert.deepEqual(roots, [path.join(REAL_HOME, ".codex"), "\\\\wsl$\\Ubuntu\\home\\dev\\.codex"]);
});
