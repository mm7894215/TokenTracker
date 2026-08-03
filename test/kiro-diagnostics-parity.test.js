/**
 * Parity lock: diagnostics.js deliberately inlines the Kiro path resolvers
 * (to avoid loading the ~14k-line rollout module on every status call), and
 * its comment promises to "keep the platform branches in lockstep" with
 * rollout.js. This suite makes that promise executable so the copies cannot
 * silently drift — the exact failure mode the repo has hit before with
 * multi-site pricing constants.
 *
 * One mockPlatform call per test — repeated t.mock.property on the same
 * property in a single test hangs the process at teardown (Node 24).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { mockPlatform } = require("./helpers/mock");

const {
  resolveKiroIdeBaseInline,
  resolveKiroCliDbPathInline,
} = require("../src/lib/diagnostics");
const { resolveKiroBasePath, resolveKiroCliDbPath } = require("../src/lib/rollout");

// rollout's resolveKiroBasePath derives home from os.homedir(); the inline
// copy takes it as a parameter — pass the same value so only the platform
// branches are under test.
function assertIdeParity(env) {
  assert.equal(resolveKiroIdeBaseInline(env, os.homedir()), resolveKiroBasePath(env));
}

// rollout's resolveKiroCliDbPath falls back to env.HOME || os.homedir();
// mirror that for the inline copy's home parameter.
function assertCliParity(env) {
  assert.equal(
    resolveKiroCliDbPathInline(env, env.HOME || os.homedir()),
    resolveKiroCliDbPath(env),
  );
}

test("kiro path resolver parity: win32", (t) => {
  mockPlatform(t, "win32");
  assertIdeParity({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
  assertIdeParity({});
  assertCliParity({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
  assertCliParity({ HOME: "/win-home" });
  assertCliParity({ KIRO_CLI_DB_PATH: "/custom/db.sqlite3" });
});

test("kiro path resolver parity: linux", (t) => {
  mockPlatform(t, "linux");
  assertIdeParity({ XDG_CONFIG_HOME: "/home/u/.config" });
  assertIdeParity({});
  assertCliParity({ XDG_DATA_HOME: "/home/u/.local/share" });
  assertCliParity({ HOME: "/home/u" });
});

test("kiro path resolver parity: darwin", (t) => {
  mockPlatform(t, "darwin");
  assertIdeParity({});
  assertCliParity({ HOME: "/Users/u" });
  assertCliParity({});
});
