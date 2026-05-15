const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  GROK_HOOK_FILENAME,
  buildGrokSessionEndHookJson,
  probeGrokHookState,
  resolveGrokHome,
  upsertGrokHook,
} = require("../src/lib/grok-hook");

test("resolveGrokHome prefers TokenTracker-prefixed override", () => {
  assert.equal(
    resolveGrokHome({
      TOKENTRACKER_GROK_HOME: "/tmp/tokentracker-grok",
      GROK_HOME: "/tmp/legacy-grok",
    }),
    "/tmp/tokentracker-grok",
  );
  assert.equal(resolveGrokHome({ GROK_HOME: "/tmp/legacy-grok" }), "/tmp/legacy-grok");
});

test("buildGrokSessionEndHookJson quotes handler paths for shell command", () => {
  const hookJson = buildGrokSessionEndHookJson({
    notifyGrokHandlerPath: "/tmp/Token Tracker's/bin/grok-session-end-hook.cjs",
  });

  assert.equal(
    hookJson.hooks.SessionEnd[0].hooks[0].command,
    "/usr/bin/env node '/tmp/Token Tracker'\\''s/bin/grok-session-end-hook.cjs'",
  );
});

test("upsertGrokHook writes handler to canonical tokentracker bin dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-hook-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHome = path.join(tmp, ".grok");

    const result = await upsertGrokHook({
      home: tmp,
      trackerDir,
      env: { GROK_HOME: grokHome },
    });

    const hookPath = path.join(grokHome, "hooks", GROK_HOOK_FILENAME);
    const handlerPath = path.join(tmp, ".tokentracker", "bin", "grok-session-end-hook.cjs");
    const legacyHandlerPath = path.join(trackerDir, "bin", "grok-session-end-hook.cjs");

    assert.equal(result.hookPath, hookPath);
    assert.equal(result.handlerPath, handlerPath);
    assert.match(await fs.readFile(hookPath, "utf8"), new RegExp(handlerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await fs.stat(handlerPath);
    await assert.rejects(fs.stat(legacyHandlerPath), /ENOENT/);

    const state = await probeGrokHookState({
      home: tmp,
      trackerDir,
      env: { GROK_HOME: grokHome },
    });
    assert.equal(state.configured, true);
    assert.equal(state.handlerExists, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
