const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { restoreCodexNotify, restoreEveryCodeNotify } = require("../lib/codex-config");
const { removeClaudeHook, buildClaudeHookCommand, buildHookCommand } = require("../lib/claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  buildGeminiHookCommand,
  removeGeminiHook,
} = require("../lib/gemini-config");
const { resolveOpencodeConfigDir, removeOpencodePlugin } = require("../lib/opencode-config");
const { removeOpenclawHookConfig } = require("../lib/openclaw-hook");
const { removeOpenclawSessionPluginConfig } = require("../lib/openclaw-session-plugin");
const { removeGrokHook } = require("../lib/grok-hook");
const { resolveTrackerPaths } = require("../lib/tracker-paths");

async function cmdUninstall(argv) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir, binDir } = await resolveTrackerPaths({ home });
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codeHome = process.env.CODE_HOME || path.join(home, ".code");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const codebuddyDir = process.env.CODEBUDDY_HOME || path.join(home, ".codebuddy");
  const codebuddySettingsPath = path.join(codebuddyDir, "settings.json");
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({ configDir: geminiConfigDir });
  const opencodeConfigDir = resolveOpencodeConfigDir({ home, env: process.env });
  const notifyPath = path.join(binDir, "notify.cjs");
  const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
  const codeNotifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
  const codexNotifyCmd = ["/usr/bin/env", "node", notifyPath];
  const codeNotifyCmd = ["/usr/bin/env", "node", notifyPath, "--source=every-code"];
  const claudeHookCommand = buildClaudeHookCommand(notifyPath);
  const codebuddyHookCommand = buildHookCommand(notifyPath, "codebuddy");
  const geminiHookCommand = buildGeminiHookCommand(notifyPath);

  const codexConfigExists = await isFile(codexConfigPath);
  const codeConfigExists = await isFile(codeConfigPath);
  const claudeConfigExists = await isFile(claudeSettingsPath);
  const codebuddyConfigExists = await isFile(codebuddySettingsPath);
  const geminiConfigExists = await isDir(geminiConfigDir);
  const opencodeConfigExists = await isDir(opencodeConfigDir);
  const codexRestore = codexConfigExists
    ? await restoreCodexNotify({
        codexConfigPath,
        notifyOriginalPath,
        notifyCmd: codexNotifyCmd,
      })
    : { restored: false, skippedReason: "config-missing" };
  const codeRestore = codeConfigExists
    ? await restoreEveryCodeNotify({
        codeConfigPath,
        notifyOriginalPath: codeNotifyOriginalPath,
        notifyCmd: codeNotifyCmd,
      })
    : { restored: false, skippedReason: "config-missing" };
  const claudeRemove = claudeConfigExists
    ? await removeClaudeHook({ settingsPath: claudeSettingsPath, hookCommand: claudeHookCommand })
    : { removed: false, skippedReason: "config-missing" };
  const codebuddyRemove = codebuddyConfigExists
    ? await removeClaudeHook({
        settingsPath: codebuddySettingsPath,
        hookCommand: codebuddyHookCommand,
      })
    : { removed: false, skippedReason: "config-missing" };
  const geminiRemove = geminiConfigExists
    ? await removeGeminiHook({ settingsPath: geminiSettingsPath, hookCommand: geminiHookCommand })
    : { removed: false, skippedReason: "config-missing" };
  const opencodeRemove = opencodeConfigExists
    ? await removeOpencodePlugin({ configDir: opencodeConfigDir })
    : { removed: false, skippedReason: "config-missing" };
  const openclawSessionPluginRemove = await removeOpenclawSessionPluginConfig({
    home,
    trackerDir,
    env: process.env,
  });
  const openclawHookRemove = await removeOpenclawHookConfig({ home, trackerDir, env: process.env });
  const grokHookRemove = await removeGrokHook({ home, trackerDir, env: process.env });

  // Remove installed notify handler.
  await fs.unlink(notifyPath).catch(() => {});

  // Remove local app runtime (installed by init for notify-driven sync).
  await fs.rm(path.join(trackerDir, "app"), { recursive: true, force: true }).catch(() => {});

  if (opts.purge) {
    await fs.rm(path.join(home, ".tokentracker"), { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(
    [
      "Uninstalled:",
      codexConfigExists
        ? codexRestore?.restored
          ? `- Codex notify restored: ${codexConfigPath}`
          : codexRestore?.skippedReason === "no-backup-not-installed"
            ? "- Codex notify: skipped (no backup; not installed)"
            : "- Codex notify: no change"
        : "- Codex notify: skipped (config.toml not found)",
      codeConfigExists
        ? codeRestore?.restored
          ? `- Every Code notify restored: ${codeConfigPath}`
          : codeRestore?.skippedReason === "no-backup-not-installed"
            ? "- Every Code notify: skipped (no backup; not installed)"
            : "- Every Code notify: no change"
        : "- Every Code notify: skipped (config.toml not found)",
      claudeConfigExists
        ? claudeRemove?.removed
          ? `- Claude hooks removed: ${claudeSettingsPath}`
          : claudeRemove?.skippedReason === "hook-missing"
            ? "- Claude hooks: no change"
            : "- Claude hooks: skipped"
        : "- Claude hooks: skipped (settings.json not found)",
      codebuddyConfigExists
        ? codebuddyRemove?.removed
          ? `- CodeBuddy hooks removed: ${codebuddySettingsPath}`
          : codebuddyRemove?.skippedReason === "hook-missing"
            ? "- CodeBuddy hooks: no change"
            : "- CodeBuddy hooks: skipped"
        : "- CodeBuddy hooks: skipped (settings.json not found)",
      geminiConfigExists
        ? geminiRemove?.removed
          ? `- Gemini hooks removed: ${geminiSettingsPath}`
          : geminiRemove?.skippedReason === "hook-missing"
            ? "- Gemini hooks: no change"
            : "- Gemini hooks: skipped"
        : `- Gemini hooks: skipped (${geminiConfigDir} not found)`,
      opencodeConfigExists
        ? opencodeRemove?.removed
          ? `- Opencode plugin removed: ${opencodeConfigDir}`
          : opencodeRemove?.skippedReason === "plugin-missing"
            ? "- Opencode plugin: no change"
            : opencodeRemove?.skippedReason === "unexpected-content"
              ? "- Opencode plugin: skipped (unexpected content)"
              : "- Opencode plugin: skipped"
        : `- Opencode plugin: skipped (${opencodeConfigDir} not found)`,
      openclawSessionPluginRemove?.removed
        ? `- OpenClaw session plugin removed: ${openclawSessionPluginRemove.openclawConfigPath}`
        : openclawSessionPluginRemove?.skippedReason === "openclaw-config-missing"
          ? "- OpenClaw session plugin: skipped (openclaw config not found)"
          : "- OpenClaw session plugin: no change",
      openclawHookRemove?.removed
        ? `- OpenClaw hook (legacy) removed: ${openclawHookRemove.openclawConfigPath}`
        : openclawHookRemove?.skippedReason === "openclaw-config-missing"
          ? "- OpenClaw hook (legacy): skipped (openclaw config not found)"
          : "- OpenClaw hook (legacy): no change",
      grokHookRemove?.removed
        ? `- Grok Build hook removed: ${grokHookRemove.hookPath}`
        : "- Grok Build hook: no change",
      opts.purge ? `- Purged: ${path.join(home, ".tokentracker")}` : "- Purge: skipped (use --purge)",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = { purge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--purge") out.purge = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

module.exports = { cmdUninstall };

async function isFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch (_e) {
    return false;
  }
}

async function isDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch (_e) {
    return false;
  }
}
