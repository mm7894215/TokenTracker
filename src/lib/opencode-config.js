const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { ensureDir } = require("./fs");

const DEFAULT_PLUGIN_NAME = "tokentracker.js";
const PLUGIN_MARKER = "TOKENTRACKER_PLUGIN";
const DEFAULT_EVENT = "session.updated";

function resolveOpencodeConfigDir({ home = os.homedir(), env = process.env } = {}) {
  const explicit =
    typeof env.OPENCODE_CONFIG_DIR === "string" ? env.OPENCODE_CONFIG_DIR.trim() : "";
  if (explicit) return path.resolve(explicit);
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const base = xdg || path.join(home, ".config");
  return path.join(base, "opencode");
}

function resolveOpencodePluginDir({ configDir }) {
  return path.join(configDir, "plugin");
}

function buildOpencodePlugin({ notifyPath }) {
  const safeNotifyPath = typeof notifyPath === "string" ? notifyPath : "";
  return (
    `// ${PLUGIN_MARKER}\n` +
    `const notifyPath = ${JSON.stringify(safeNotifyPath)};\n` +
    `export const TokenTrackerPlugin = async ({ $ }) => {\n` +
    `  return {\n` +
    `    event: async ({ event }) => {\n` +
    `      if (!event || event.type !== ${JSON.stringify(DEFAULT_EVENT)}) return;\n` +
    `      try {\n` +
    `        if (!notifyPath) return;\n` +
    // `node` (not `/usr/bin/env node`): /usr/bin/env does not exist on Windows, so the Bun
    // shell exec fails and its error leaks into the OpenCode TUI input box (issue #189).
    // `.quiet()` keeps any subprocess output out of the TUI even on success/warnings.
    `        const proc = $\`node ${"${notifyPath}"} --source=opencode\`.quiet();\n` +
    `        if (proc && typeof proc.catch === 'function') proc.catch(() => {});\n` +
    `      } catch (_) {}\n` +
    `    }\n` +
    `  };\n` +
    `};\n`
  );
}

async function upsertOpencodePlugin({ configDir, notifyPath, pluginName = DEFAULT_PLUGIN_NAME }) {
  if (!configDir) return { changed: false, pluginPath: null, skippedReason: "config-missing" };
  const pluginDir = resolveOpencodePluginDir({ configDir });
  const pluginPath = path.join(pluginDir, pluginName);
  const next = buildOpencodePlugin({ notifyPath });
  const existing = await fs.readFile(pluginPath, "utf8").catch(() => null);

  if (existing === next) {
    return { changed: false, pluginPath, skippedReason: null };
  }

  await ensureDir(pluginDir);

  let backupPath = null;
  if (existing != null) {
    backupPath = `${pluginPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(pluginPath, backupPath).catch(() => {});
  }

  await fs.writeFile(pluginPath, next, "utf8");
  return { changed: true, pluginPath, backupPath, skippedReason: null };
}

async function removeOpencodePlugin({ configDir, pluginName = DEFAULT_PLUGIN_NAME }) {
  if (!configDir) return { removed: false, skippedReason: "config-missing" };
  const pluginPath = path.join(resolveOpencodePluginDir({ configDir }), pluginName);
  const existing = await fs.readFile(pluginPath, "utf8").catch(() => null);
  if (existing == null) return { removed: false, skippedReason: "plugin-missing" };
  if (!hasPluginMarker(existing)) return { removed: false, skippedReason: "unexpected-content" };
  await fs.unlink(pluginPath).catch(() => {});
  return { removed: true, skippedReason: null };
}

async function isOpencodePluginInstalled({ configDir, pluginName = DEFAULT_PLUGIN_NAME }) {
  if (!configDir) return false;
  const pluginPath = path.join(resolveOpencodePluginDir({ configDir }), pluginName);
  const existing = await fs.readFile(pluginPath, "utf8").catch(() => null);
  if (!existing) return false;
  return hasPluginMarker(existing);
}

function hasPluginMarker(text) {
  return typeof text === "string" && text.includes(PLUGIN_MARKER);
}

module.exports = {
  DEFAULT_EVENT,
  DEFAULT_PLUGIN_NAME,
  PLUGIN_MARKER,
  resolveOpencodeConfigDir,
  resolveOpencodePluginDir,
  buildOpencodePlugin,
  upsertOpencodePlugin,
  removeOpencodePlugin,
  isOpencodePluginInstalled,
};
