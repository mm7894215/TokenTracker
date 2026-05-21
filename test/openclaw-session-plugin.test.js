const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  OPENCLAW_SESSION_PLUGIN_ID,
  resolveOpenclawSessionPluginPaths,
  ensureOpenclawSessionPluginFiles,
  probeOpenclawSessionPluginState,
  installOpenclawSessionPlugin,
  removeOpenclawSessionPluginConfig,
} = require("../src/lib/openclaw-session-plugin");

test("probeOpenclawSessionPluginState detects linked + enabled plugin", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-plugin-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { pluginEntryDir, openclawConfigPath } = resolveOpenclawSessionPluginPaths({
    home,
    trackerDir,
    env: {},
  });
  await ensureOpenclawSessionPluginFiles({
    pluginDir: path.dirname(pluginEntryDir),
    trackerDir,
    packageName: "tokentracker-cli",
  });
  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });
  await fs.writeFile(
    openclawConfigPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            [OPENCLAW_SESSION_PLUGIN_ID]: { enabled: true },
          },
          load: {
            paths: [pluginEntryDir],
          },
          installs: {
            [OPENCLAW_SESSION_PLUGIN_ID]: {
              source: "path",
              sourcePath: pluginEntryDir,
              installPath: pluginEntryDir,
              version: "0.0.0",
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const state = await probeOpenclawSessionPluginState({ home, trackerDir, env: {} });
  assert.equal(state.configured, true);
  assert.equal(state.enabled, true);
  assert.equal(state.linked, true);
  assert.equal(state.installed, true);
  assert.equal(state.pluginFilesReady, true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("installOpenclawSessionPlugin returns skipped when openclaw CLI is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-plugin-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const result = await installOpenclawSessionPlugin({
    home,
    trackerDir,
    packageName: "tokentracker-cli",
    env: { PATH: "", OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json") },
  });

  assert.equal(result.configured, false);
  assert.equal(result.skippedReason, "openclaw-cli-missing");

  await fs.rm(tmp, { recursive: true, force: true });
});

test("removeOpenclawSessionPluginConfig removes linked config and plugin dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-plugin-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { pluginEntryDir, openclawConfigPath } = resolveOpenclawSessionPluginPaths({
    home,
    trackerDir,
    env: {},
  });
  await ensureOpenclawSessionPluginFiles({
    pluginDir: path.dirname(pluginEntryDir),
    trackerDir,
    packageName: "tokentracker-cli",
  });
  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });

  const keepPath = path.join(tmp, "keep-plugin-path");
  await fs.mkdir(keepPath, { recursive: true });

  await fs.writeFile(
    openclawConfigPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            [OPENCLAW_SESSION_PLUGIN_ID]: { enabled: true },
            keep_plugin: { enabled: true },
          },
          load: {
            paths: [pluginEntryDir, keepPath],
          },
          installs: {
            [OPENCLAW_SESSION_PLUGIN_ID]: {
              source: "path",
              sourcePath: pluginEntryDir,
              installPath: pluginEntryDir,
              version: "0.0.0",
            },
            keep_plugin: {
              source: "path",
              sourcePath: keepPath,
              installPath: keepPath,
              version: "0.0.0",
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const removed = await removeOpenclawSessionPluginConfig({ home, trackerDir, env: {} });
  assert.equal(removed.removed, true);

  const next = JSON.parse(await fs.readFile(openclawConfigPath, "utf8"));
  assert.equal(Boolean(next?.plugins?.entries?.[OPENCLAW_SESSION_PLUGIN_ID]), false);
  assert.equal(Boolean(next?.plugins?.entries?.keep_plugin), true);
  assert.deepEqual(next?.plugins?.load?.paths, [keepPath]);
  assert.equal(Boolean(next?.plugins?.installs?.[OPENCLAW_SESSION_PLUGIN_ID]), false);
  assert.equal(Boolean(next?.plugins?.installs?.keep_plugin), true);

  await assert.rejects(() => fs.stat(pluginEntryDir));

  await fs.rm(tmp, { recursive: true, force: true });
});

test("ensureOpenclawSessionPluginFiles includes agent/session lifecycle hooks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-plugin-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });

  const { pluginEntryDir } = resolveOpenclawSessionPluginPaths({ home, trackerDir, env: {} });
  await ensureOpenclawSessionPluginFiles({
    pluginDir: path.dirname(pluginEntryDir),
    trackerDir,
    packageName: "tokentracker-cli",
  });

  const pkg = JSON.parse(await fs.readFile(path.join(pluginEntryDir, "package.json"), "utf8"));
  assert.deepEqual(pkg.openclaw?.extensions, ["./index.js"]);

  const index = await fs.readFile(path.join(pluginEntryDir, "index.js"), "utf8");
  assert.match(index, /api\.on\('agent_end'/);
  assert.match(index, /api\.on\('gateway_start'/);
  assert.match(index, /api\.on\('gateway_stop'/);
  assert.match(index, /TOKENTRACKER_OPENCLAW_PREV_SESSION_ID/);

  await fs.rm(tmp, { recursive: true, force: true });
});
