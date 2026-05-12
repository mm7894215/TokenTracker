const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

const { readJson } = require("../lib/fs");
const { readCodexNotify, readEveryCodeNotify } = require("../lib/codex-config");
const {
  isClaudeHookConfigured,
  buildClaudeHookCommand,
  buildHookCommand,
} = require("../lib/claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  isGeminiHookConfigured,
  buildGeminiHookCommand,
} = require("../lib/gemini-config");
const {
  resolveOpencodeConfigDir,
  isOpencodePluginInstalled,
} = require("../lib/opencode-config");
const { collectLocalSubscriptions } = require("../lib/subscriptions");
const {
  describeCopilotOtelStatus,
  readCopilotOauthToken,
} = require("../lib/usage-limits");
const {
  normalizeState: normalizeUploadState,
} = require("../lib/upload-throttle");
const { collectTrackerDiagnostics } = require("../lib/diagnostics");
const { probeOpenclawHookState } = require("../lib/openclaw-hook");
const {
  probeOpenclawSessionPluginState,
} = require("../lib/openclaw-session-plugin");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const {
  resolveKimiWireFiles,
  resolveKiroCliDbPath,
  resolveCodebuddyHome,
  resolveCodebuddyProjectFiles,
  resolveOmpSessionFiles,
  resolveOmpAgentDir,
  resolvePiSessionFiles,
  resolvePiAgentDir,
  piAgentDirCollidesWithOmp,
  resolveCraftSessionFiles,
  resolveCraftConfigDir,
  resolveKilocodeTaskFiles,
} = require("../lib/rollout");

async function cmdStatus(argv = []) {
  const opts = parseArgs(argv);
  if (opts.diagnostics) {
    const diagnostics = await collectTrackerDiagnostics();
    process.stdout.write(JSON.stringify(diagnostics, null, 2) + "\n");
    return;
  }

  const home = os.homedir();
  const { trackerDir, binDir } = await resolveTrackerPaths({ home });
  const configPath = path.join(trackerDir, "config.json");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const queueStatePath = path.join(trackerDir, "queue.state.json");
  const cursorsPath = path.join(trackerDir, "cursors.json");
  const notifySignalPath = path.join(trackerDir, "notify.signal");
  const openclawSignalPath = path.join(trackerDir, "openclaw.signal");
  const throttlePath = path.join(trackerDir, "sync.throttle");
  const uploadThrottlePath = path.join(trackerDir, "upload.throttle.json");
  const autoRetryPath = path.join(trackerDir, "auto.retry.json");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codeHome = process.env.CODE_HOME || path.join(home, ".code");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const codebuddySettingsPath = path.join(
    process.env.CODEBUDDY_HOME || path.join(home, ".codebuddy"),
    "settings.json",
  );
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({
    configDir: geminiConfigDir,
  });
  const opencodeConfigDir = resolveOpencodeConfigDir({
    home,
    env: process.env,
  });
  const notifyPath = path.join(binDir, "notify.cjs");
  const claudeHookCommand = buildClaudeHookCommand(notifyPath);
  const codebuddyHookCommand = buildHookCommand(notifyPath, "codebuddy");
  const geminiHookCommand = buildGeminiHookCommand(notifyPath);

  const config = await readJson(configPath);
  const cursors = await readJson(cursorsPath);
  const queueState = (await readJson(queueStatePath)) || { offset: 0 };
  const uploadThrottle = normalizeUploadState(
    await readJson(uploadThrottlePath),
  );
  const autoRetry = await readJson(autoRetryPath);

  const queueSize = await safeStatSize(queuePath);
  const pendingBytes = Math.max(0, queueSize - (queueState.offset || 0));

  const lastNotify = (await safeReadText(notifySignalPath))?.trim() || null;
  const lastOpenclawSync =
    (await safeReadText(openclawSignalPath))?.trim() || null;
  const lastNotifySpawn = parseEpochMsToIso(
    (await safeReadText(throttlePath))?.trim() || null,
  );

  const codexNotify = await readCodexNotify(codexConfigPath);
  const notifyConfigured = Array.isArray(codexNotify) && codexNotify.length > 0;
  const everyCodeNotify = await readEveryCodeNotify(codeConfigPath);
  const everyCodeConfigured =
    Array.isArray(everyCodeNotify) && everyCodeNotify.length > 0;
  const claudeHookConfigured = await isClaudeHookConfigured({
    settingsPath: claudeSettingsPath,
    hookCommand: claudeHookCommand,
  });
  const codebuddyHookConfigured = await isClaudeHookConfigured({
    settingsPath: codebuddySettingsPath,
    hookCommand: codebuddyHookCommand,
  });
  const geminiHookConfigured = await isGeminiHookConfigured({
    settingsPath: geminiSettingsPath,
    hookCommand: geminiHookCommand,
  });
  const opencodePluginConfigured = await isOpencodePluginInstalled({
    configDir: opencodeConfigDir,
  });
  const openclawSessionPluginState = await probeOpenclawSessionPluginState({
    home,
    trackerDir,
    env: process.env,
  });
  const openclawHookState = await probeOpenclawHookState({
    home,
    trackerDir,
    env: process.env,
  });

  const lastUpload = uploadThrottle.lastSuccessMs
    ? parseEpochMsToIso(uploadThrottle.lastSuccessMs)
    : typeof queueState.updatedAt === "string"
      ? queueState.updatedAt
      : null;
  const nextUpload = parseEpochMsToIso(uploadThrottle.nextAllowedAtMs || null);
  const backoffUntil = parseEpochMsToIso(uploadThrottle.backoffUntilMs || null);
  const lastUploadError = uploadThrottle.lastError
    ? `${uploadThrottle.lastErrorAt || "unknown"} ${uploadThrottle.lastError}`
    : null;
  const autoRetryAt = parseEpochMsToIso(autoRetry?.retryAtMs || null);
  const autoRetryLine = autoRetryAt
    ? `- Auto retry after: ${autoRetryAt} (${autoRetry?.reason || "scheduled"}, pending ${Number(
        autoRetry?.pendingBytes || 0,
      )} bytes)`
    : null;

  const subscriptions = await collectLocalSubscriptions({
    home,
    env: process.env,
    probeKeychain: opts.probeKeychain,
    probeKeychainDetails: opts.probeKeychainDetails,
  });
  const subscriptionLines =
    subscriptions.length > 0 ? subscriptions.map(formatSubscriptionLine) : [];

  const kimiWireFiles = resolveKimiWireFiles(process.env);
  const kimiHome = process.env.KIMI_HOME || path.join(home, ".kimi");
  const kimiInstalled = fssync.existsSync(path.join(kimiHome, "sessions"));

  // Kiro CLI — reads from SQLite at
  // ~/Library/Application Support/kiro-cli/data.sqlite3. End-user dashboards
  // show CLI and IDE merged under a single "Kiro" brand; this status line
  // surfaces the CLI sub-path separately for operators.
  const kiroCliDbPath = resolveKiroCliDbPath(process.env);
  const kiroCliInstalled = fssync.existsSync(kiroCliDbPath);

  // CodeBuddy — passive scan only (no hooks). Surface the file count so
  // operators can confirm jsonl logs are being discovered.
  const codebuddyHome = resolveCodebuddyHome(process.env);
  const codebuddyInstalled = fssync.existsSync(codebuddyHome);
  const codebuddyFiles = codebuddyInstalled
    ? resolveCodebuddyProjectFiles(process.env)
    : [];

  // oh-my-pi — passive scan only (no hooks).
  const ompAgentDir = resolveOmpAgentDir(process.env);
  const ompInstalled = fssync.existsSync(path.join(ompAgentDir, "sessions"));
  const ompFiles = ompInstalled ? resolveOmpSessionFiles(process.env) : [];

  // pi (@mariozechner/pi-coding-agent) — passive scan only (no hooks).
  // Skip when its agent dir collides with omp's; sync would dedupe anyway.
  const piCollides = piAgentDirCollidesWithOmp(process.env);
  const piAgentDir = resolvePiAgentDir(process.env);
  const piInstalled = !piCollides && fssync.existsSync(path.join(piAgentDir, "sessions"));
  const piFiles = piInstalled ? resolvePiSessionFiles(process.env) : [];

  // Craft Agents — passive scan only (no hooks).
  const craftConfigDir = resolveCraftConfigDir(process.env);
  const craftInstalled = fssync.existsSync(craftConfigDir);
  const craftFiles = craftInstalled ? resolveCraftSessionFiles(process.env) : [];

  // Kilo CLI (kilo.ai @kilocode/plugin) — passive scan of kilo.db.
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const kiloHome = process.env.KILO_HOME || path.join(xdgDataHome, "kilo");
  const kiloDbPath = path.join(kiloHome, "kilo.db");
  const kiloInstalled = fssync.existsSync(kiloDbPath);

  // Kilo Code VS Code extension — passive scan of all VS Code-family
  // globalStorage/kilocode.kilo-code/tasks/ ui_messages.json files.
  const kilocodeTaskFiles = resolveKilocodeTaskFiles(process.env);
  const kilocodeInstalled = kilocodeTaskFiles.length > 0;

  const copilotToken = readCopilotOauthToken({ home });
  const copilotOtel = describeCopilotOtelStatus({ home, env: process.env });
  const copilotLines = formatCopilotLines({
    token: copilotToken,
    otel: copilotOtel,
  });

  process.stdout.write(
    [
      "Status:",
      `- Base URL: ${config?.baseUrl || "unset"}`,
      `- Device token: ${config?.deviceToken ? "set" : "unset"}`,
      `- Queue: ${pendingBytes} bytes pending`,
      `- Last parse: ${cursors?.updatedAt || "never"}`,
      `- Last notify: ${lastNotify || "never"}`,
      `- Last OpenClaw-triggered sync: ${lastOpenclawSync || "never"}`,
      `- Last notify-triggered sync: ${lastNotifySpawn || "never"}`,
      `- Last upload: ${lastUpload || "never"}`,
      `- Next upload after: ${nextUpload || "never"}`,
      `- Backoff until: ${backoffUntil || "never"}`,
      lastUploadError ? `- Last upload error: ${lastUploadError}` : null,
      autoRetryLine,
      `- Codex notify: ${notifyConfigured ? JSON.stringify(codexNotify) : "unset"}`,
      `- Every Code notify: ${everyCodeConfigured ? JSON.stringify(everyCodeNotify) : "unset"}`,
      `- Claude hooks: ${claudeHookConfigured ? "set" : "unset"}`,
      `- Gemini hooks: ${geminiHookConfigured ? "set" : "unset"}`,
      `- Opencode plugin: ${opencodePluginConfigured ? "set" : "unset"}`,
      `- OpenClaw session plugin: ${openclawSessionPluginState?.configured ? "set" : "unset"}`,
      `- OpenClaw hook (legacy): ${openclawHookState?.configured ? "set" : "unset"}`,
      kimiInstalled
        ? `- Kimi Code: passive reader (${kimiWireFiles.length} wire.jsonl file${kimiWireFiles.length !== 1 ? "s" : ""} found)`
        : null,
      kiroCliInstalled
        ? `- Kiro CLI: SQLite data.sqlite3 found (tokens approximated from char lengths, merged under 'kiro' source)`
        : null,
      codebuddyInstalled
        ? `- CodeBuddy hooks: ${codebuddyHookConfigured ? "set" : "unset"} (${codebuddyFiles.length} session jsonl file${codebuddyFiles.length !== 1 ? "s" : ""} found)`
        : null,
      ompInstalled
        ? `- oh-my-pi: passive reader (${ompFiles.length} session jsonl file${ompFiles.length !== 1 ? "s" : ""} found)`
        : null,
      piInstalled
        ? `- pi: passive reader (${piFiles.length} session jsonl file${piFiles.length !== 1 ? "s" : ""} found)`
        : null,
      craftInstalled
        ? `- Craft Agents: passive reader (${craftFiles.length} session jsonl file${craftFiles.length !== 1 ? "s" : ""} found)`
        : null,
      kiloInstalled
        ? `- Kilo CLI: passive reader (${kiloDbPath})`
        : null,
      kilocodeInstalled
        ? `- Kilo Code (VS Code extension): passive reader (${kilocodeTaskFiles.length} task${kilocodeTaskFiles.length !== 1 ? "s" : ""} across ${new Set(kilocodeTaskFiles.map((t) => t.ide)).size} IDE${new Set(kilocodeTaskFiles.map((t) => t.ide)).size !== 1 ? "s" : ""})`
        : null,
      ...copilotLines,
      ...subscriptionLines,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function formatCopilotLines({ token, otel }) {
  if (!token && !otel.otel_has_files) return [];
  const limitsState = token
    ? "set (via GitHub OAuth)"
    : "unset (no Copilot OAuth token found)";
  const usageState = otel.otel_has_files
    ? `set (${otel.otel_path || otel.otel_default_dir})`
    : otel.otel_enabled
      ? "enabled but no files yet"
      : "unset (OTEL export not enabled)";
  const lines = [
    `- GitHub Copilot limits: ${limitsState}`,
    `- GitHub Copilot usage (OTEL): ${usageState}`,
  ];
  if (!otel.otel_has_files) {
    lines.push(
      "    To track Copilot token usage, add to your shell profile:",
      "      export COPILOT_OTEL_ENABLED=true",
      "      export COPILOT_OTEL_EXPORTER_TYPE=file",
      `      export COPILOT_OTEL_FILE_EXPORTER_PATH="${otel.otel_default_dir}/copilot-otel-$(date +%Y%m%d).jsonl"`,
    );
  }
  return lines;
}

function formatSubscriptionLine(entry = {}) {
  const tool = String(entry.tool || "");
  const provider = String(entry.provider || "");
  const product = String(entry.product || "");
  const planType = String(entry.planType || "");
  const rateLimitTier = String(entry.rateLimitTier || "");
  const toolLabel =
    tool === "codex"
      ? "Codex"
      : tool === "opencode"
        ? "OpenCode"
        : tool === "claude"
          ? "Claude Code"
          : tool;

  if (!planType) return null;

  if (
    tool === "claude" &&
    provider === "anthropic" &&
    product === "subscription"
  ) {
    const suffix = rateLimitTier ? ` (rate limit tier: ${rateLimitTier})` : "";
    return `- ${toolLabel} subscription: ${planType}${suffix}`;
  }

  if (provider === "openai" && product === "chatgpt") {
    return `- ${toolLabel} ChatGPT plan: ${planType}`;
  }

  const productLabel = product ? product.replace(/_/g, " ") : "subscription";
  return `- ${toolLabel} ${productLabel}: ${planType}`;
}

function parseArgs(argv) {
  const out = {
    diagnostics: false,
    probeKeychain: false,
    probeKeychainDetails: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--diagnostics" || a === "--json") out.diagnostics = true;
    else if (a === "--probe-keychain") out.probeKeychain = true;
    else if (a === "--probe-keychain-details") {
      out.probeKeychainDetails = true;
      out.probeKeychain = true;
    } else throw new Error(`Unknown option: ${a}`);
  }

  return out;
}

async function safeStatSize(p) {
  try {
    const st = await fs.stat(p);
    return st.size || 0;
  } catch (_e) {
    return 0;
  }
}

async function safeReadText(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (_e) {
    return null;
  }
}

function parseEpochMsToIso(v) {
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = { cmdStatus };
