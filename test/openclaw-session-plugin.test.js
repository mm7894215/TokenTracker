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

test("probeOpenclawSessionPluginState rejects linked + enabled plugin without conversation access", async () => {
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
  assert.equal(state.configured, false);
  assert.equal(state.enabled, true);
  assert.equal(state.linked, true);
  assert.equal(state.installed, true);
  assert.equal(state.pluginFilesReady, true);
  assert.equal(state.conversationAccess, false);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("probeOpenclawSessionPluginState requires conversation hook access", async () => {
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
            [OPENCLAW_SESSION_PLUGIN_ID]: {
              enabled: true,
              hooks: { allowConversationAccess: true },
            },
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
  assert.equal(state.conversationAccess, true);

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

test("installOpenclawSessionPlugin grants OpenClaw conversation hook access", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-openclaw-plugin-"));
  const home = path.join(tmp, "home");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const fakeBinDir = path.join(tmp, "bin");
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.mkdir(fakeBinDir, { recursive: true });

  const { openclawConfigPath } = resolveOpenclawSessionPluginPaths({
    home,
    trackerDir,
    env: {},
  });
  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });
  await fs.writeFile(openclawConfigPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

  const fakeOpenclawPath = path.join(fakeBinDir, "openclaw");
  await fs.writeFile(
    fakeOpenclawPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.plugins ||= {};
cfg.plugins.entries ||= {};
cfg.plugins.load ||= {};
cfg.plugins.load.paths ||= [];
cfg.plugins.installs ||= {};
if (args[0] === 'plugins' && args[1] === 'install' && args[2] === '--link') {
  const pluginDir = args[3];
  const meta = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  cfg.plugins.entries[meta.id] ||= {};
  if (!cfg.plugins.load.paths.includes(pluginDir)) cfg.plugins.load.paths.push(pluginDir);
  cfg.plugins.installs[meta.id] = { source: 'path', sourcePath: pluginDir, installPath: pluginDir, version: '0.0.0' };
} else if (args[0] === 'plugins' && args[1] === 'enable') {
  const id = args[2];
  cfg.plugins.entries[id] ||= {};
  cfg.plugins.entries[id].enabled = true;
} else {
  process.exit(2);
}
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\\n');
`,
    "utf8",
  );
  await fs.chmod(fakeOpenclawPath, 0o755);

  const result = await installOpenclawSessionPlugin({
    home,
    trackerDir,
    packageName: "tokentracker-cli",
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
      OPENCLAW_CONFIG_PATH: openclawConfigPath,
    },
  });

  const cfg = JSON.parse(await fs.readFile(openclawConfigPath, "utf8"));
  assert.equal(result.configured, true);
  assert.equal(
    cfg.plugins.entries[OPENCLAW_SESSION_PLUGIN_ID].hooks.allowConversationAccess,
    true,
  );

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
