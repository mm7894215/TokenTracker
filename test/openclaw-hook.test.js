const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  OPENCLAW_HOOK_NAME,
  resolveOpenclawHookPaths,
  ensureOpenclawHookFiles,
  probeOpenclawHookState,
  installOpenclawHook,
  removeOpenclawHookConfig,
} = require("../src/lib/openclaw-hook");

test("probeOpenclawHookState detects linked + enabled hook", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-hook-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { hookDir, openclawConfigPath } = resolveOpenclawHookPaths({ home, trackerDir, env: {} });
  await ensureOpenclawHookFiles({ hookDir, trackerDir, packageName: "tokentracker-cli" });
  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });
  await fs.writeFile(
    openclawConfigPath,
    JSON.stringify(
      {
        hooks: {
          internal: {
            entries: {
              [OPENCLAW_HOOK_NAME]: { enabled: true },
            },
            load: {
              extraDirs: [hookDir],
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const state = await probeOpenclawHookState({ home, trackerDir, env: {} });
  assert.equal(state.configured, true);
  assert.equal(state.enabled, true);
  assert.equal(state.linked, true);
  assert.equal(state.hookFilesReady, true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("installOpenclawHook returns skipped when openclaw CLI is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-hook-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const result = await installOpenclawHook({
    home,
    trackerDir,
    packageName: "tokentracker-cli",
    env: { PATH: "", OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json") },
  });

  assert.equal(result.configured, false);
  assert.equal(result.skippedReason, "openclaw-cli-missing");

  await fs.rm(tmp, { recursive: true, force: true });
});

test("removeOpenclawHookConfig removes linked config and hook dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-hook-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { hookDir, openclawConfigPath } = resolveOpenclawHookPaths({ home, trackerDir, env: {} });
  await ensureOpenclawHookFiles({ hookDir, trackerDir, packageName: "tokentracker-cli" });
  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });

  const keepDir = path.join(tmp, "keep-hook-dir");
  await fs.mkdir(keepDir, { recursive: true });

  await fs.writeFile(
    openclawConfigPath,
    JSON.stringify(
      {
        hooks: {
          internal: {
            entries: {
              [OPENCLAW_HOOK_NAME]: { enabled: true },
              keep_hook: { enabled: true },
            },
            load: {
              extraDirs: [hookDir, keepDir],
            },
            installs: {
              [OPENCLAW_HOOK_NAME]: {
                source: "path",
                sourcePath: hookDir,
                installPath: hookDir,
                hooks: [OPENCLAW_HOOK_NAME],
              },
              keep_hook: {
                source: "path",
                sourcePath: keepDir,
                installPath: keepDir,
                hooks: ["keep_hook"],
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const removed = await removeOpenclawHookConfig({ home, trackerDir, env: {} });
  assert.equal(removed.removed, true);

  const next = JSON.parse(await fs.readFile(openclawConfigPath, "utf8"));
  assert.equal(Boolean(next?.hooks?.internal?.entries?.[OPENCLAW_HOOK_NAME]), false);
  assert.equal(Boolean(next?.hooks?.internal?.entries?.keep_hook), true);
  assert.deepEqual(next?.hooks?.internal?.load?.extraDirs, [keepDir]);
  assert.equal(Boolean(next?.hooks?.internal?.installs?.[OPENCLAW_HOOK_NAME]), false);
  assert.equal(Boolean(next?.hooks?.internal?.installs?.keep_hook), true);

  await assert.rejects(() => fs.stat(hookDir));

  await fs.rm(tmp, { recursive: true, force: true });
});

test("ensureOpenclawHookFiles keeps command-only trigger set and command guard", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-hook-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { hookDir, hookEntryDir } = resolveOpenclawHookPaths({ home, trackerDir, env: {} });
  await ensureOpenclawHookFiles({ hookDir, trackerDir, packageName: "tokentracker-cli" });

  const hookMd = await fs.readFile(path.join(hookEntryDir, "HOOK.md"), "utf8");
  assert.doesNotMatch(hookMd, /"agent:bootstrap"/);
  assert.match(hookMd, /"command:new"/);
  assert.match(hookMd, /"command:reset"/);
  assert.match(hookMd, /"command:stop"/);

  const handler = await fs.readFile(path.join(hookEntryDir, "handler.js"), "utf8");
  assert.match(handler, /if \(!event \|\| event\.type !== 'command'\) return;/);
  assert.match(
    handler,
    /if \(event\.action !== 'new' && event\.action !== 'reset' && event\.action !== 'stop'\) return;/,
  );
  assert.match(handler, /if \(!event \|\| event\.type !== 'command'\) return null;/);

  await fs.rm(tmp, { recursive: true, force: true });
});
