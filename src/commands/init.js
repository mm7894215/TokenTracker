const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const {
  ensureDir,
  writeFileAtomic,
  readJson,
  writeJson,
  chmod600IfPossible,
} = require("../lib/fs");
const { prompt, promptHidden } = require("../lib/prompt");
const {
  upsertCodexNotify,
  upsertEveryCodeNotify,
  readCodexNotify,
  readEveryCodeNotify,
} = require("../lib/codex-config");
const {
  upsertClaudeHook,
  buildClaudeHookCommand,
  isClaudeHookConfigured,
} = require("../lib/claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  buildGeminiHookCommand,
  upsertGeminiHook,
  isGeminiHookConfigured,
} = require("../lib/gemini-config");
const {
  resolveOpencodeConfigDir,
  upsertOpencodePlugin,
  isOpencodePluginInstalled,
} = require("../lib/opencode-config");
const { isCursorInstalled, extractCursorSessionToken } = require("../lib/cursor-config");
const { removeOpenclawHookConfig, probeOpenclawHookState } = require("../lib/openclaw-hook");
const {
  installOpenclawSessionPlugin,
  probeOpenclawSessionPluginState,
} = require("../lib/openclaw-session-plugin");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { resolveRuntimeConfig, DEFAULT_BASE_URL } = require("../lib/runtime-config");
const {
  BOLD,
  DIM,
  CYAN,
  RESET,
  color,
  isInteractive,
  promptMenu,
  createSpinner,
} = require("../lib/cli-ui");
const { renderLocalReport, renderAuthTransition, renderSuccessBox } = require("../lib/init-flow");

const ASCII_LOGO = [
  "████████╗ ██████╗ ██╗  ██╗███████╗███╗   ██╗",
  "╚══██╔══╝██╔═══██╗██║ ██╔╝██╔════╝████╗  ██║",
  "   ██║   ██║   ██║█████╔╝ █████╗  ██╔██╗ ██║",
  "   ██║   ██║   ██║██╔═██╗ ██╔══╝  ██║╚██╗██║",
  "   ██║   ╚██████╔╝██║  ██╗███████╗██║ ╚████║",
  "   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝",
  "      ████████╗██████╗  █████╗  ██████╗██╗  ██╗███████╗██████╗",
  "      ╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝██╔════╝██╔══██╗",
  "         ██║   ██████╔╝███████║██║     █████╔╝ █████╗  ██████╔╝",
  "         ██║   ██╔══██╗██╔══██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗",
  "         ██║   ██║  ██║██║  ██║╚██████╗██║  ██╗███████╗██║  ██║",
  "         ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
].join("\n");

const DIVIDER = "----------------------------------------------";
const DEFAULT_DASHBOARD_URL = "https://token.rynn.me";

async function cmdInit(argv) {
  const opts = parseArgs(argv);
  const home = os.homedir();

  const { rootDir, trackerDir, binDir } = await resolveTrackerPaths({ home });

  const configPath = path.join(trackerDir, "config.json");
  const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
  const linkCodeStatePath = path.join(trackerDir, "link_code_state.json");

  const existingConfig = await readJson(configPath);
  const runtime = resolveRuntimeConfig({
    cli: { baseUrl: opts.baseUrl, dashboardUrl: opts.dashboardUrl },
    config: existingConfig || {},
    env: process.env,
  });
  const baseUrl = runtime.baseUrl;
  let dashboardUrl = runtime.dashboardUrl || DEFAULT_DASHBOARD_URL;
  const notifyPath = path.join(binDir, "notify.cjs");
  const appDir = path.join(trackerDir, "app");
  const trackerBinPath = path.join(appDir, "bin", "tracker.js");

  renderWelcome();

  if (opts.dryRun) {
    process.stdout.write(`${color("Dry run: preview only (no changes applied).", DIM)}\n\n`);
  }

  if (isInteractive() && !opts.yes && !opts.dryRun) {
    const choice = await promptMenu({
      message: "? Proceed with installation?",
      options: ["Yes, configure my environment", "No, exit"],
      defaultIndex: 0,
    });
    const normalizedChoice = String(choice || "")
      .trim()
      .toLowerCase();
    if (normalizedChoice.startsWith("no") || normalizedChoice.includes("exit")) {
      process.stdout.write("Setup cancelled.\n");
      return;
    }
  }

  if (opts.dryRun) {
    const preview = await buildDryRunSummary({
      opts,
      home,
      trackerDir,
      notifyPath,
      runtime,
    });
    renderLocalReport({ summary: preview.summary, isDryRun: true });
    renderAccountNotLinked({ context: "dry-run" });
    return;
  }

  const spinner = createSpinner({ text: "Analyzing and configuring local environment..." });
  spinner.start();
  let setup;
  try {
    setup = await runSetup({
      opts,
      home,
      baseUrl,
      trackerDir,
      binDir,
      configPath,
      notifyOriginalPath,
      linkCodeStatePath,
      notifyPath,
      appDir,
      trackerBinPath,
      runtime,
      existingConfig,
    });
  } catch (err) {
    spinner.stop();
    throw err;
  }
  spinner.stop();

  renderLocalReport({ summary: setup.summary, isDryRun: false });

  renderLocalSuccess();

  try {
    spawnInitSync({ trackerBinPath, packageName: "tokentracker" });
  } catch (err) {
    const msg = err && err.message ? err.message : "unknown error";
    process.stderr.write(`Initial sync spawn failed: ${msg}\n`);
  }
}

function renderWelcome() {
  process.stdout.write(
    [
      ASCII_LOGO,
      "",
      `${BOLD}Welcome to Token Tracker${RESET}`,
      DIVIDER,
      `${CYAN}Privacy First: Your data stays local. Only token counts are tracked — never prompts or responses.${RESET}`,
      DIVIDER,
      "",
      "This tool will:",
      "  - Detect your AI CLI tools (Codex, Claude, Gemini, OpenCode, Cursor, OpenClaw)",
      "  - Set up lightweight hooks to track token usage",
      "  - View your dashboard at http://localhost:7680",
      "",
      "(Nothing will be changed until you confirm below)",
      "",
    ].join("\n"),
  );
}

function renderLocalSuccess() {
  process.stdout.write(
    [
      "",
      `${BOLD}Setup complete!${RESET}`,
      "",
      "  Token data will be collected automatically via hooks.",
      "  Launching dashboard...",
      "",
      // One-shot, post-success star CTA. `init` is run once per machine, so
      // this is the only place a CLI user naturally sees the project's
      // GitHub URL — and they're at peak satisfaction. No prompts in
      // status/doctor/sync/etc, which run in scripts and would be noisy.
      `  ${color("⭐ Liking it? Star us at https://github.com/mm7894215/TokenTracker", DIM)}`,
      "",
    ].join("\n"),
  );
}

function renderAccountNotLinked({ context } = {}) {
  if (context === "dry-run") {
    process.stdout.write(
      [
        "",
        "Dry run complete. Run init without --dry-run to apply changes.",
        "",
      ].join("\n"),
    );
    return;
  }
  renderLocalSuccess();
}

function shouldUseBrowserAuth({ deviceToken, opts }) {
  if (deviceToken) return false;
  if (opts.noAuth) return false;
  if (opts.linkCode) return false;
  if (opts.email || opts.password) return false;
  return true;
}

async function buildDryRunSummary({ opts, home, trackerDir, notifyPath, runtime }) {
  const deviceToken = runtime?.deviceToken || null;
  const pendingBrowserAuth = shouldUseBrowserAuth({ deviceToken, opts });
  const context = buildIntegrationTargets({ home, trackerDir, notifyPath });
  const summary = await previewIntegrations({ context });
  return { summary, pendingBrowserAuth, deviceToken };
}

async function runSetup({
  opts,
  home,
  baseUrl,
  trackerDir,
  binDir,
  configPath,
  notifyOriginalPath,
  linkCodeStatePath,
  notifyPath,
  appDir,
  trackerBinPath,
  runtime,
  existingConfig,
}) {
  await ensureDir(trackerDir);
  await ensureDir(binDir);
  let deviceToken = runtime?.deviceToken || null;
  let deviceId = existingConfig?.deviceId || null;
  const installedAt = existingConfig?.installedAt || new Date().toISOString();
  let pendingBrowserAuth = false;

  await installLocalTrackerApp({ appDir });

  const config = {
    installedAt,
    baseUrl: DEFAULT_BASE_URL,
  };

  await writeJson(configPath, config);
  await chmod600IfPossible(configPath);

  await writeFileAtomic(
    notifyPath,
    buildNotifyHandler({ trackerDir, trackerBinPath, packageName: "tokentracker-cli" }),
  );
  await fs.chmod(notifyPath, 0o755).catch(() => {});

  const summary = await applyIntegrationSetup({
    home,
    trackerDir,
    notifyPath,
    notifyOriginalPath,
  });

  return {
    summary,
    pendingBrowserAuth,
    deviceToken,
    deviceId,
    installedAt,
  };
}

function buildIntegrationTargets({ home, trackerDir, notifyPath }) {
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codeHome = process.env.CODE_HOME || path.join(home, ".code");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
  const codeNotifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
  const notifyCmd = ["/usr/bin/env", "node", notifyPath];
  const codeNotifyCmd = ["/usr/bin/env", "node", notifyPath, "--source=every-code"];
  const claudeDir = path.join(home, ".claude");
  const claudeSettingsPath = path.join(claudeDir, "settings.json");
  const claudeHookCommand = buildClaudeHookCommand(notifyPath);
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({ configDir: geminiConfigDir });
  const geminiHookCommand = buildGeminiHookCommand(notifyPath);
  const opencodeConfigDir = resolveOpencodeConfigDir({ home, env: process.env });

  return {
    trackerDir,
    codexConfigPath,
    codeConfigPath,
    notifyOriginalPath,
    codeNotifyOriginalPath,
    notifyCmd,
    codeNotifyCmd,
    claudeDir,
    claudeSettingsPath,
    claudeHookCommand,
    geminiConfigDir,
    geminiSettingsPath,
    geminiHookCommand,
    opencodeConfigDir,
  };
}

async function applyIntegrationSetup({ home, trackerDir, notifyPath, notifyOriginalPath }) {
  const context = buildIntegrationTargets({ home, trackerDir, notifyPath });
  context.notifyOriginalPath = notifyOriginalPath;

  const summary = [];

  const codexProbe = await probeFile(context.codexConfigPath);
  if (codexProbe.exists) {
    const result = await upsertCodexNotify({
      codexConfigPath: context.codexConfigPath,
      notifyCmd: context.notifyCmd,
      notifyOriginalPath: context.notifyOriginalPath,
    });
    summary.push({
      label: "Codex CLI",
      status: result.changed ? "updated" : "set",
      detail: result.changed ? "Updated config" : "Config already set",
    });
  } else {
    summary.push({ label: "Codex CLI", status: "skipped", detail: renderSkipDetail(codexProbe) });
  }

  const claudeDirExists = await isDir(context.claudeDir);
  if (claudeDirExists) {
    await upsertClaudeHook({
      settingsPath: context.claudeSettingsPath,
      hookCommand: context.claudeHookCommand,
    });
    summary.push({ label: "Claude", status: "installed", detail: "Hooks installed" });
  } else {
    summary.push({ label: "Claude", status: "skipped", detail: "Config not found" });
  }

  const geminiConfigExists = await isDir(context.geminiConfigDir);
  if (geminiConfigExists) {
    await upsertGeminiHook({
      settingsPath: context.geminiSettingsPath,
      hookCommand: context.geminiHookCommand,
    });
    summary.push({ label: "Gemini", status: "installed", detail: "Hooks installed" });
  } else {
    summary.push({ label: "Gemini", status: "skipped", detail: "Config not found" });
  }

  const opencodeResult = await upsertOpencodePlugin({
    configDir: context.opencodeConfigDir,
    notifyPath,
  });
  if (opencodeResult?.skippedReason === "config-missing") {
    summary.push({ label: "Opencode Plugin", status: "skipped", detail: "Config not found" });
  } else {
    summary.push({
      label: "Opencode Plugin",
      status: opencodeResult?.changed ? "installed" : "set",
      detail: "Plugin installed",
    });
  }

  // Cursor (API-based, no hooks needed)
  if (isCursorInstalled({ home })) {
    const cursorAuth = extractCursorSessionToken({ home });
    if (cursorAuth) {
      summary.push({
        label: "Cursor",
        status: "detected",
        detail: "Usage synced via Cursor API (no hooks needed)",
      });
    } else {
      summary.push({
        label: "Cursor",
        status: "skipped",
        detail: "Installed but not logged in (login in Cursor to enable)",
      });
    }
  } else {
    summary.push({ label: "Cursor", status: "skipped", detail: "Not installed" });
  }

  // Kimi: passive reader — no hook installation needed.
  // TokenTracker reads ~/.kimi/sessions/**/wire.jsonl directly.
  {
    const kimiHome = process.env.KIMI_HOME || path.join(home, ".kimi");
    const kimiSessions = path.join(kimiHome, "sessions");
    const fssync = require("node:fs");
    if (fssync.existsSync(kimiSessions)) {
      summary.push({ label: "Kimi Code", status: "detected", detail: "Passive reader (no hook needed)" });
    }
  }

  const openclawBefore = await probeOpenclawSessionPluginState({
    home,
    trackerDir,
    env: process.env,
  });
  const openclawInstall = await installOpenclawSessionPlugin({
    home,
    trackerDir,
    packageName: "tokentracker-cli",
    env: process.env,
  });
  if (openclawInstall?.skippedReason === "openclaw-cli-missing") {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: "OpenClaw CLI not found",
    });
  } else if (openclawInstall?.skippedReason === "openclaw-plugins-install-failed") {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: `Install failed${openclawInstall.error ? `: ${openclawInstall.error}` : ""}`,
    });
  } else if (openclawInstall?.skippedReason === "openclaw-config-unreadable") {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: openclawInstall.error
        ? `OpenClaw config unreadable: ${openclawInstall.error}`
        : "OpenClaw config unreadable",
    });
  } else if (openclawInstall?.configured) {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: openclawBefore?.configured ? "set" : "installed",
      detail: openclawBefore?.configured
        ? "Session plugin already linked"
        : "Session plugin linked (restart OpenClaw gateway to activate)",
    });
  } else {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: "OpenClaw session plugin unavailable",
    });
  }

  const legacyHookState = await probeOpenclawHookState({ home, trackerDir, env: process.env });
  if (legacyHookState?.configured || legacyHookState?.linked || legacyHookState?.enabled) {
    await removeOpenclawHookConfig({ home, trackerDir, env: process.env });
    summary.push({
      label: "OpenClaw Hook (legacy)",
      status: "updated",
      detail: "Removed legacy command hook (migrated to session plugin)",
    });
  }

  const codeProbe = await probeFile(context.codeConfigPath);
  if (codeProbe.exists) {
    const result = await upsertEveryCodeNotify({
      codeConfigPath: context.codeConfigPath,
      notifyCmd: context.codeNotifyCmd,
      notifyOriginalPath: context.codeNotifyOriginalPath,
    });
    summary.push({
      label: "Every Code",
      status: result.changed ? "updated" : "set",
      detail: result.changed ? "Updated config" : "Config already set",
    });
  } else {
    summary.push({ label: "Every Code", status: "skipped", detail: renderSkipDetail(codeProbe) });
  }

  return summary;
}

async function previewIntegrations({ context }) {
  const summary = [];
  const home = os.homedir();

  const codexProbe = await probeFile(context.codexConfigPath);
  if (codexProbe.exists) {
    const existing = await readCodexNotify(context.codexConfigPath);
    const matches = arraysEqual(existing, context.notifyCmd);
    summary.push({
      label: "Codex CLI",
      status: matches ? "set" : "updated",
      detail: matches ? "Already configured" : "Will update config",
    });
  } else {
    summary.push({ label: "Codex CLI", status: "skipped", detail: renderSkipDetail(codexProbe) });
  }

  const claudeDirExists = await isDir(context.claudeDir);
  if (claudeDirExists) {
    const configured = await isClaudeHookConfigured({
      settingsPath: context.claudeSettingsPath,
      hookCommand: context.claudeHookCommand,
    });
    summary.push({
      label: "Claude",
      status: "installed",
      detail: configured ? "Hooks already installed" : "Will install hooks",
    });
  } else {
    summary.push({ label: "Claude", status: "skipped", detail: "Config not found" });
  }

  const geminiConfigExists = await isDir(context.geminiConfigDir);
  if (geminiConfigExists) {
    const configured = await isGeminiHookConfigured({
      settingsPath: context.geminiSettingsPath,
      hookCommand: context.geminiHookCommand,
    });
    summary.push({
      label: "Gemini",
      status: "installed",
      detail: configured ? "Hooks already installed" : "Will install hooks",
    });
  } else {
    summary.push({ label: "Gemini", status: "skipped", detail: "Config not found" });
  }

  const opencodeDirExists = await isDir(context.opencodeConfigDir);
  const installed = await isOpencodePluginInstalled({ configDir: context.opencodeConfigDir });
  const opencodeDetail = installed
    ? "Plugin already installed"
    : opencodeDirExists
      ? "Will install plugin"
      : "Will create config and install plugin";
  summary.push({
    label: "Opencode Plugin",
    status: "installed",
    detail: opencodeDetail,
  });

  const openclawState = await probeOpenclawSessionPluginState({
    home,
    trackerDir: context.trackerDir,
    env: process.env,
  });
  if (openclawState?.skippedReason === "openclaw-config-missing") {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: "OpenClaw config not found",
    });
  } else if (openclawState?.skippedReason === "openclaw-config-unreadable") {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: "skipped",
      detail: openclawState.error
        ? `OpenClaw config unreadable: ${openclawState.error}`
        : "OpenClaw config unreadable",
    });
  } else {
    summary.push({
      label: "OpenClaw Session Plugin",
      status: openclawState?.configured ? "set" : "installed",
      detail: openclawState?.configured
        ? "Session plugin already linked"
        : "Will link session plugin (restart OpenClaw gateway to activate)",
    });
  }

  const legacyHookState = await probeOpenclawHookState({
    home,
    trackerDir: context.trackerDir,
    env: process.env,
  });
  if (legacyHookState?.configured || legacyHookState?.linked || legacyHookState?.enabled) {
    summary.push({
      label: "OpenClaw Hook (legacy)",
      status: "updated",
      detail: "Will remove legacy command hook during migration",
    });
  }

  const codeProbe = await probeFile(context.codeConfigPath);
  if (codeProbe.exists) {
    const existing = await readEveryCodeNotify(context.codeConfigPath);
    const matches = arraysEqual(existing, context.codeNotifyCmd);
    summary.push({
      label: "Every Code",
      status: matches ? "set" : "updated",
      detail: matches ? "Already configured" : "Will update config",
    });
  } else {
    summary.push({ label: "Every Code", status: "skipped", detail: renderSkipDetail(codeProbe) });
  }

  return summary;
}

function renderSkipDetail(probe) {
  if (!probe || probe.reason === "missing") return "Config not found";
  if (probe.reason === "permission-denied") return "Permission denied";
  if (probe.reason === "not-file") return "Invalid config";
  return "Unavailable";
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseArgs(argv) {
  const out = {
    baseUrl: null,
    dashboardUrl: null,
    email: null,
    password: null,
    deviceName: null,
    linkCode: null,
    noAuth: false,
    noOpen: false,
    yes: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") out.baseUrl = argv[++i] || null;
    else if (a === "--dashboard-url") out.dashboardUrl = argv[++i] || null;
    else if (a === "--email") out.email = argv[++i] || null;
    else if (a === "--password") out.password = argv[++i] || null;
    else if (a === "--device-name") out.deviceName = argv[++i] || null;
    else if (a === "--link-code") out.linkCode = argv[++i] || null;
    else if (a === "--no-auth") out.noAuth = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePlatform(value) {
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  if (value === "linux") return "linux";
  return "unknown";
}

function buildNotifyHandler({ trackerDir, packageName }) {
  // Keep this file dependency-free: Node built-ins only.
  // It must never block Codex; it spawns sync in the background and exits 0.
  const queueSignalPath = path.join(trackerDir, "notify.signal");
  const originalPath = path.join(trackerDir, "codex_notify_original.json");
  const fallbackPkg = packageName || "tokentracker-cli";
  const trackerBinPath = path.join(trackerDir, "app", "bin", "tracker.js");

  return `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const rawArgs = process.argv.slice(2);
let source = 'codex';
const payloadArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--source') {
    source = rawArgs[i + 1] || source;
    i += 1;
    continue;
  }
  if (arg.startsWith('--source=')) {
    source = arg.slice('--source='.length) || source;
    continue;
  }
  payloadArgs.push(arg);
}

const trackerDir = ${JSON.stringify(trackerDir)};
const signalPath = ${JSON.stringify(queueSignalPath)};
const codexOriginalPath = ${JSON.stringify(originalPath)};
const codeOriginalPath = ${JSON.stringify(path.join(trackerDir, "code_notify_original.json"))};
const trackerBinPath = ${JSON.stringify(trackerBinPath)};
  const depsMarkerPath = path.join(trackerDir, 'app', 'bin', 'tracker.js');
  const configPath = path.join(trackerDir, 'config.json');
const fallbackPkg = ${JSON.stringify(fallbackPkg)};
const selfPath = path.resolve(__filename);
const home = os.homedir();
const debugLogPath = path.join(trackerDir, 'notify.debug.jsonl');
const debugEnabled = ['1', 'true'].includes((process.env.TOKENTRACKER_NOTIFY_DEBUG || '').toLowerCase());
const debugMaxBytesRaw = Number.parseInt(process.env.TOKENTRACKER_NOTIFY_DEBUG_MAX_BYTES || '', 10);
const debugMaxBytes = Number.isFinite(debugMaxBytesRaw) && debugMaxBytesRaw > 0
  ? debugMaxBytesRaw
  : 1_000_000;

try {
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(signalPath, new Date().toISOString(), { encoding: 'utf8' });
} catch (_) {}

if (debugEnabled) {
  try {
    let size = 0;
    try {
      size = fs.statSync(debugLogPath).size;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    if (size < debugMaxBytes) {
      const entry = {
        ts: new Date().toISOString(),
        source,
        cwd: process.cwd()
      };
      fs.appendFileSync(debugLogPath, JSON.stringify(entry) + os.EOL, 'utf8');
    }
  } catch (_) {}
}

// Throttle spawn: at most once per 20 seconds.
try {
    const throttlePath = path.join(trackerDir, 'sync.throttle');
    let deviceToken = process.env.TOKENTRACKER_DEVICE_TOKEN || null;
    if (!deviceToken) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg && typeof cfg.deviceToken === 'string') deviceToken = cfg.deviceToken;
      } catch (_) {}
    }
    const canSync = Boolean(deviceToken && deviceToken.length > 0);
    const now = Date.now();
    let last = 0;
    try { last = Number(fs.readFileSync(throttlePath, 'utf8')) || 0; } catch (_) {}
    if (canSync && now - last > 20_000) {
    try { fs.writeFileSync(throttlePath, String(now), 'utf8'); } catch (_) {}
    const hasLocalRuntime = fs.existsSync(trackerBinPath);
    const hasLocalDeps = fs.existsSync(depsMarkerPath);
    if (hasLocalRuntime && hasLocalDeps) {
      spawnDetached([process.execPath, trackerBinPath, 'sync', '--auto', '--from-notify']);
    } else {
      spawnDetached(['npx', '--yes', fallbackPkg, 'sync', '--auto', '--from-notify']);
    }
  }
} catch (_) {}

// Chain the original notify if present (Codex/Every Code only).
try {
  const originalPath =
    source === 'every-code'
      ? codeOriginalPath
      : source === 'claude' || source === 'opencode' || source === 'gemini'
        ? null
        : codexOriginalPath;
  if (originalPath) {
    const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
    const cmd = Array.isArray(original?.notify) ? original.notify : null;
    if (cmd && cmd.length > 0 && !isSelfNotify(cmd)) {
      const args = cmd.slice(1);
      if (payloadArgs.length > 0) args.push(...payloadArgs);
      spawnDetached([cmd[0], ...args]);
    }
  }
} catch (_) {}

process.exit(0);

function spawnDetached(argv) {
  try {
    const child = cp.spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
  } catch (_) {}
}

function resolveMaybeHome(p) {
  if (typeof p !== 'string') return null;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(p);
}

function isSelfNotify(cmd) {
  for (const part of cmd) {
    if (typeof part !== 'string') continue;
    if (!part.includes('notify.cjs')) continue;
    const resolved = resolveMaybeHome(part);
    if (resolved && resolved === selfPath) return true;
  }
  return false;
}
`;
}

module.exports = { cmdInit };

async function probeFile(p) {
  try {
    const st = await fs.stat(p);
    if (st.isFile()) return { exists: true, reason: null };
    return { exists: false, reason: "not-file" };
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { exists: false, reason: "missing" };
    if (e?.code === "EACCES" || e?.code === "EPERM")
      return { exists: false, reason: "permission-denied" };
    return { exists: false, reason: "error", code: e?.code || "unknown" };
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

async function installLocalTrackerApp({ appDir }) {
  // Copy the current package's runtime (bin + src) into ~/.tokentracker so notify can run sync without npx.
  const packageRoot = path.resolve(__dirname, "../..");
  const srcFrom = path.join(packageRoot, "src");
  const binFrom = path.join(packageRoot, "bin", "tracker.js");
  const nodeModulesFrom = path.join(packageRoot, "node_modules");

  // When running from the installed local runtime (or when appDir is symlinked to this package),
  // source and destination resolve to the same place. Do not delete appDir in that case.
  if (await pathsPointToSameLocation(packageRoot, appDir)) {
    return;
  }

  const srcTo = path.join(appDir, "src");
  const binToDir = path.join(appDir, "bin");
  const binTo = path.join(binToDir, "tracker.js");
  const nodeModulesTo = path.join(appDir, "node_modules");

  await fs.rm(appDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(appDir);
  await fs.cp(srcFrom, srcTo, { recursive: true });
  await ensureDir(binToDir);
  await fs.copyFile(binFrom, binTo);
  await fs.chmod(binTo, 0o755).catch(() => {});
  await copyRuntimeDependencies({ from: nodeModulesFrom, to: nodeModulesTo });
}

async function pathsPointToSameLocation(a, b) {
  const aReal = await safeRealpath(a);
  const bReal = await safeRealpath(b);
  if (aReal && bReal) return aReal === bReal;
  return path.resolve(a) === path.resolve(b);
}

async function safeRealpath(p) {
  try {
    return await fs.realpath(p);
  } catch (_err) {
    return null;
  }
}

function spawnInitSync({ trackerBinPath, packageName }) {
  const fallbackPkg = packageName || "tokentracker-cli";
  const argv = ["sync", "--drain"];
  const hasLocalRuntime = typeof trackerBinPath === "string" && fssync.existsSync(trackerBinPath);
  const cmd = hasLocalRuntime
    ? [process.execPath, trackerBinPath, ...argv]
    : ["npx", "--yes", fallbackPkg, ...argv];
  const child = cp.spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.on("error", (err) => {
    const msg = err && err.message ? err.message : "unknown error";
    const detail = isDebugEnabled() ? ` (${msg})` : "";
    process.stderr.write(`Minor issue: Background sync could not start${detail}.\n`);
    process.stderr.write("Run: npx --yes tokentracker-cli sync\n");
  });
  child.unref();
}

async function copyRuntimeDependencies({ from, to }) {
  try {
    const st = await fs.stat(from);
    if (!st.isDirectory()) return;
  } catch (_e) {
    return;
  }

  try {
    await fs.cp(from, to, { recursive: true });
  } catch (_e) {
    // Best-effort: missing dependencies will fall back to npx at notify time.
  }
}

function isDebugEnabled() {
  return process.env.TOKENTRACKER_DEBUG === "1";
}
