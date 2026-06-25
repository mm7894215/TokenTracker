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
const { detectPassiveProviders, isPassiveModeActive } = require("../lib/passive-mode");
const { probeOpenclawHookState } = require("../lib/openclaw-hook");
const {
  probeOpenclawSessionPluginState,
} = require("../lib/openclaw-session-plugin");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const {
  resolveKimiWireFiles,
  resolveKimiCodeWireFiles,
  resolveKiroCliDbPath,
  resolveCodebuddyHome,
  resolveCodebuddyProjectFiles,
  resolveWorkbuddyHome,
  resolveWorkbuddyProjectFiles,
  resolveOmpSessionFiles,
  resolveOmpAgentDir,
  resolvePiSessionFiles,
  resolvePiAgentDir,
  piAgentDirCollidesWithOmp,
  resolveCraftSessionFiles,
  resolveCraftConfigDir,
  resolveKilocodeTaskFiles,
  resolveRoocodeTaskFiles,
  resolveZedDbPath,
  resolveGooseDbPath,
  listDroidSettingsFiles,
  resolveDroidSessionsDir,
  resolveGrokBuildSessions,
} = require("../lib/rollout");
const { probeGrokHookState, resolveGrokHome } = require("../lib/grok-hook");

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
  const workbuddySettingsPath = path.join(
    process.env.WORKBUDDY_HOME || path.join(home, ".workbuddy"),
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
  const workbuddyHookCommand = buildHookCommand(notifyPath, "workbuddy");
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
  const workbuddyHookConfigured = await isClaudeHookConfigured({
    settingsPath: workbuddySettingsPath,
    hookCommand: workbuddyHookCommand,
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

  const kimiCodeWireFiles = resolveKimiCodeWireFiles(process.env);
  const kimiCodeHome = process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
  const kimiCodeInstalled = fssync.existsSync(path.join(kimiCodeHome, "sessions"));

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

  // WorkBuddy — passive scan (sibling Claude-Code fork). Surface the recursive
  // jsonl file count (main session logs + nested subagents) for operators.
  const workbuddyHome = resolveWorkbuddyHome(process.env);
  const workbuddyInstalled = fssync.existsSync(workbuddyHome);
  const workbuddyFiles = workbuddyInstalled
    ? resolveWorkbuddyProjectFiles(process.env)
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

  // Mimo (mimocode — OpenCode-fork SQLite) — passive scan of mimocode.db.
  const mimoHome = process.env.MIMO_HOME || path.join(xdgDataHome, "mimocode");
  const mimoDbPath = path.join(mimoHome, "mimocode.db");
  const mimoInstalled = fssync.existsSync(mimoDbPath);

  // ZCode (Z.ai's coding agent — OpenCode-fork SQLite) — passive scan of db.sqlite.
  const zcodeHome = process.env.ZCODE_HOME || path.join(home, ".zcode");
  const zcodeDbPath = path.join(zcodeHome, "cli", "db", "db.sqlite");
  const zcodeInstalled = fssync.existsSync(zcodeDbPath);

  // Kilo Code VS Code extension — passive scan of all VS Code-family
  // globalStorage/kilocode.kilo-code/tasks/ ui_messages.json files.
  const kilocodeTaskFiles = resolveKilocodeTaskFiles(process.env);
  const kilocodeInstalled = kilocodeTaskFiles.length > 0;

  // Roo Code VS Code extension — same Cline-derived ui_messages.json format,
  // different globalStorage subdir (rooveterinaryinc.roo-cline).
  const roocodeTaskFiles = resolveRoocodeTaskFiles(process.env);
  const roocodeInstalled = roocodeTaskFiles.length > 0;

  // Zed Agent — passive read of threads.db across all model providers
  // (hosted "zed.dev" and bring-your-own alike). threadTotals tracks one entry
  // per thread we've surfaced usage for, so its size distinguishes "DB present
  // with usage" from "DB present but nothing counted yet" (fresh/undecodable).
  const zedDbPath = resolveZedDbPath(process.env);
  const zedInstalled = fssync.existsSync(zedDbPath);
  const zedThreadsCounted =
    cursors?.zed?.threadTotals && typeof cursors.zed.threadTotals === "object"
      ? Object.keys(cursors.zed.threadTotals).length
      : 0;

  // Goose (Block) — passive cumulative-delta read of sessions.db.
  const gooseDbPath = resolveGooseDbPath(process.env);
  const gooseInstalled = fssync.existsSync(gooseDbPath);

  // Droid (Factory CLI) — passive cumulative-delta read of *.settings.json.
  const droidSessionsDir = resolveDroidSessionsDir(process.env);
  const droidSettingsFiles = listDroidSettingsFiles(process.env);
  const droidInstalled = droidSettingsFiles.length > 0;

  // Grok Build (xAI TUI)
  const grokHookState = await probeGrokHookState({ home, trackerDir, env: process.env });
  const grokSessions = grokHookState.hasGrokInstall || grokHookState.sessionsDir
    ? resolveGrokBuildSessions(process.env)
    : [];
  const grokInstalled = grokHookState.hasGrokInstall || grokSessions.length > 0;

  const copilotToken = readCopilotOauthToken({ home });
  const copilotOtel = describeCopilotOtelStatus({ home, env: process.env });
  const copilotLines = formatCopilotLines({
    token: copilotToken,
    otel: copilotOtel,
  });

  // Detect passive-mode providers exactly once — both the JSON/light path
  // and the human-readable path consume this, and each call hits 5 readdir
  // syscalls (~5–10ms cold). Memoize.
  const passiveProviders = detectPassiveProviders({
    home,
    hookStatus: {
      codex_notify: notifyConfigured,
      every_code_notify: everyCodeConfigured,
      claude: claudeHookConfigured,
      gemini: geminiHookConfigured,
      opencode_plugin: opencodePluginConfigured,
      openclaw_session_plugin: Boolean(openclawSessionPluginState?.configured),
      codebuddy: Boolean(codebuddyHookConfigured),
      workbuddy: Boolean(workbuddyHookConfigured),
      grok: Boolean(grokHookState?.configured),
    },
  });

  if (opts.json || opts.light) {
    const summary = {
      generated_at: new Date().toISOString(),
      base_url: config?.baseUrl || null,
      device_token_set: Boolean(config?.deviceToken),
      queue: {
        pending_bytes: pendingBytes,
        size_bytes: queueSize,
        offset: queueState.offset || 0,
      },
      last_parse: cursors?.updatedAt || null,
      last_notify: lastNotify || null,
      last_openclaw_sync: lastOpenclawSync || null,
      last_notify_spawn: lastNotifySpawn || null,
      last_upload: lastUpload || null,
      next_upload_after: nextUpload || null,
      backoff_until: backoffUntil || null,
      last_upload_error: lastUploadError || null,
      auto_retry: autoRetry || null,
      hooks: {
        codex_notify: notifyConfigured,
        every_code_notify: everyCodeConfigured,
        claude: claudeHookConfigured,
        gemini: geminiHookConfigured,
        opencode_plugin: opencodePluginConfigured,
        openclaw_session_plugin: Boolean(openclawSessionPluginState?.configured),
        openclaw_session_plugin_conversation_access: Boolean(
          openclawSessionPluginState?.conversationAccess,
        ),
        openclaw_legacy: Boolean(openclawHookState?.configured),
        codebuddy: codebuddyInstalled ? Boolean(codebuddyHookConfigured) : null,
        workbuddy: workbuddyInstalled ? Boolean(workbuddyHookConfigured) : null,
        grok: grokInstalled ? Boolean(grokHookState?.configured) : null,
      },
      providers: {
        kimi_code: kimiInstalled || kimiCodeInstalled
          ? { installed: true, files: kimiWireFiles.length + kimiCodeWireFiles.length }
          : { installed: false },
        kiro_cli: kiroCliInstalled
          ? { installed: true, detail: kiroCliDbPath }
          : { installed: false },
        codebuddy: codebuddyInstalled
          ? { installed: true, files: codebuddyFiles.length }
          : { installed: false },
        workbuddy: workbuddyInstalled
          ? { installed: true, files: workbuddyFiles.length }
          : { installed: false },
        omp: ompInstalled
          ? { installed: true, files: ompFiles.length }
          : { installed: false },
        pi: piInstalled
          ? { installed: true, files: piFiles.length }
          : { installed: false },
        craft: craftInstalled
          ? { installed: true, files: craftFiles.length }
          : { installed: false },
        kilo_cli: kiloInstalled
          ? { installed: true, detail: kiloDbPath }
          : { installed: false },
        mimo: mimoInstalled
          ? { installed: true, detail: mimoDbPath }
          : { installed: false },
        zcode: zcodeInstalled
          ? { installed: true, detail: zcodeDbPath }
          : { installed: false },
        kilocode: kilocodeInstalled
          ? { installed: true, files: kilocodeTaskFiles.length }
          : { installed: false },
        roocode: roocodeInstalled
          ? { installed: true, files: roocodeTaskFiles.length }
          : { installed: false },
        zed: zedInstalled ? { installed: true, detail: zedDbPath } : { installed: false },
        goose: gooseInstalled
          ? { installed: true, detail: gooseDbPath }
          : { installed: false },
        droid: droidInstalled
          ? { installed: true, files: droidSettingsFiles.length, detail: droidSessionsDir }
          : { installed: false },
        grok_build: grokInstalled
          ? {
              installed: true,
              files: grokSessions.length,
              detail: grokHookState.configured ? "hook installed" : "detected",
            }
          : { installed: false },
      },
      copilot: {
        token_set: Boolean(copilotToken),
        otel_has_files: Boolean(copilotOtel.otel_has_files),
        otel_path: copilotOtel.otel_path || null,
        otel_enabled: Boolean(copilotOtel.otel_enabled),
      },
      passive_mode: {
        active: isPassiveModeActive(passiveProviders),
        providers: passiveProviders,
      },
      subscriptions,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderLightTable(summary) + "\n");
    return;
  }

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
      `- OpenClaw session plugin conversation access: ${openclawSessionPluginState?.conversationAccess ? "set" : "unset"}`,
      `- OpenClaw hook (legacy): ${openclawHookState?.configured ? "set" : "unset"}`,
      kimiInstalled || kimiCodeInstalled
        ? `- Kimi Code: passive reader (${kimiWireFiles.length + kimiCodeWireFiles.length} wire.jsonl file${(kimiWireFiles.length + kimiCodeWireFiles.length) !== 1 ? "s" : ""} found)`
        : null,
      kiroCliInstalled
        ? `- Kiro CLI: SQLite data.sqlite3 found (tokens approximated from char lengths, merged under 'kiro' source)`
        : null,
      codebuddyInstalled
        ? `- CodeBuddy hooks: ${codebuddyHookConfigured ? "set" : "unset"} (${codebuddyFiles.length} session jsonl file${codebuddyFiles.length !== 1 ? "s" : ""} found)`
        : null,
      workbuddyInstalled
        ? `- WorkBuddy hooks: ${workbuddyHookConfigured ? "set" : "unset"} (${workbuddyFiles.length} session jsonl file${workbuddyFiles.length !== 1 ? "s" : ""} found)`
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
      mimoInstalled
        ? `- Mimo: passive reader (${mimoDbPath})`
        : null,
      zcodeInstalled
        ? `- ZCode: passive reader (${zcodeDbPath})`
        : null,
      kilocodeInstalled
        ? `- Kilo Code (VS Code extension): passive reader (${kilocodeTaskFiles.length} task${kilocodeTaskFiles.length !== 1 ? "s" : ""} across ${new Set(kilocodeTaskFiles.map((t) => t.ide)).size} IDE${new Set(kilocodeTaskFiles.map((t) => t.ide)).size !== 1 ? "s" : ""})`
        : null,
      roocodeInstalled
        ? `- Roo Code (VS Code extension): passive reader (${roocodeTaskFiles.length} task${roocodeTaskFiles.length !== 1 ? "s" : ""} across ${new Set(roocodeTaskFiles.map((t) => t.ide)).size} IDE${new Set(roocodeTaskFiles.map((t) => t.ide)).size !== 1 ? "s" : ""})`
        : null,
      zedInstalled
        ? `- Zed Agent: passive reader (threads.db, all providers${
            zedThreadsCounted > 0
              ? `, ${zedThreadsCounted} thread${zedThreadsCounted !== 1 ? "s" : ""} counted`
              : ", no usage counted yet"
          })`
        : null,
      gooseInstalled
        ? `- Goose (Block): passive reader (sessions.db, cumulative-delta)`
        : null,
      droidInstalled
        ? `- Droid (Factory): passive reader (${droidSettingsFiles.length} session${droidSettingsFiles.length !== 1 ? "s" : ""} in ${droidSessionsDir}, cumulative-delta)`
        : null,
      ...(() => {
        const passive = passiveProviders.filter((p) => p.passive);
        if (passive.length === 0) return [];
        return [
          `- Passive mode: ${passive.length} provider${passive.length !== 1 ? "s" : ""} reading logs without hooks (${passive.map((p) => `${p.name}: ${p.hook_failure_reason || "hook unset"}`).join("; ")})`,
        ];
      })(),
      grokInstalled
        ? `- Grok Build (xAI): ${grokHookState.configured ? "hook installed" : "detected"} (${grokSessions.length} session${grokSessions.length !== 1 ? "s" : ""} found, hook: ${grokHookState.configured ? "yes" : "no"})`
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
    json: false,
    light: false,
    noSpinner: false,
    probeKeychain: false,
    probeKeychainDetails: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--diagnostics") out.diagnostics = true;
    else if (a === "--json") out.json = true;
    else if (a === "--light") out.light = true;
    else if (a === "--no-spinner") out.noSpinner = true;
    else if (a === "--probe-keychain") out.probeKeychain = true;
    else if (a === "--probe-keychain-details") {
      out.probeKeychainDetails = true;
      out.probeKeychain = true;
    } else throw new Error(`Unknown option: ${a}`);
  }

  return out;
}

// Pure renderer: turn the structured summary into a fixed-width ASCII table.
// "light" output is for AI agents and CI: deterministic columns, no emoji or
// spinner side effects, easy to grep. Returns a string (caller adds trailing
// newline).
function renderLightTable(summary) {
  const rows = [];
  const push = (k, v) => rows.push([k, v == null || v === "" ? "—" : String(v)]);

  push("Base URL", summary.base_url);
  push("Device token", summary.device_token_set ? "set" : "unset");
  push("Queue pending (bytes)", summary.queue.pending_bytes);
  push("Queue size (bytes)", summary.queue.size_bytes);
  push("Last parse", summary.last_parse);
  push("Last notify", summary.last_notify);
  push("Last upload", summary.last_upload);
  push("Next upload after", summary.next_upload_after);
  push("Backoff until", summary.backoff_until);
  if (summary.last_upload_error) push("Last upload error", summary.last_upload_error);

  for (const [name, state] of Object.entries(summary.hooks || {})) {
    push(`Hook · ${name}`, state ? "set" : "unset");
  }

  for (const [name, info] of Object.entries(summary.providers || {})) {
    const detail = [];
    if (typeof info.installed === "boolean") detail.push(info.installed ? "installed" : "not installed");
    if (typeof info.files === "number") detail.push(`${info.files} file${info.files !== 1 ? "s" : ""}`);
    if (info.detail) detail.push(info.detail);
    push(`Provider · ${name}`, detail.length ? detail.join(", ") : "—");
  }

  if (summary.passive_mode) {
    push("Passive mode active", summary.passive_mode.active ? "yes" : "no");
    for (const p of summary.passive_mode.providers || []) {
      if (p.passive) {
        push(`Passive · ${p.name}`, `hook ${p.hook_failure_reason || "missing"}, logs present`);
      }
    }
  }

  const keyWidth = Math.max(...rows.map(([k]) => k.length), 8);
  const valWidth = Math.max(...rows.map(([, v]) => v.length), 8);
  const sep = `+${"-".repeat(keyWidth + 2)}+${"-".repeat(valWidth + 2)}+`;
  const lines = [sep, `| ${"Key".padEnd(keyWidth)} | ${"Value".padEnd(valWidth)} |`, sep];
  for (const [k, v] of rows) {
    lines.push(`| ${k.padEnd(keyWidth)} | ${v.padEnd(valWidth)} |`);
  }
  lines.push(sep);
  return lines.join("\n");
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
