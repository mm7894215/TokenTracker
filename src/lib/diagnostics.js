const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { readJson } = require("./fs");
const { readCodexNotify, readEveryCodeNotify } = require("./codex-config");
const { isClaudeHookConfigured, buildClaudeHookCommand } = require("./claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  buildGeminiHookCommand,
  isGeminiHookConfigured,
} = require("./gemini-config");
const { resolveOpencodeConfigDir, isOpencodePluginInstalled } = require("./opencode-config");
const { normalizeState: normalizeUploadState } = require("./upload-throttle");
const { probeOpenclawHookState } = require("./openclaw-hook");
const { probeOpenclawSessionPluginState } = require("./openclaw-session-plugin");
const { probeGrokHookState } = require("./grok-hook");
const { resolveTrackerPaths } = require("./tracker-paths");
// TASK-011: Kiro CLI DB path inlined here to avoid pulling the ~4000-line
// rollout module on every `tokentracker status` / `diagnostics` call.
// rollout.js still exports resolveKiroCliDbPath for external callers.
function resolveKiroCliDbPathInline(env, home) {
  if (env.KIRO_CLI_DB_PATH) return env.KIRO_CLI_DB_PATH;
  const effectiveHome = env.HOME || home;
  return path.join(
    effectiveHome,
    "Library",
    "Application Support",
    "kiro-cli",
    "data.sqlite3",
  );
}

async function collectTrackerDiagnostics({
  home = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(home, ".codex"),
  codeHome = process.env.CODE_HOME || path.join(home, ".code"),
} = {}) {
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
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const claudeConfigPath = path.join(home, ".claude", "settings.json");
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({ configDir: geminiConfigDir });
  const opencodeConfigDir = resolveOpencodeConfigDir({ home, env: process.env });
  const grokHome =
    process.env.TOKENTRACKER_GROK_HOME ||
    process.env.GROK_HOME ||
    path.join(home, ".grok");

  const config = await readJson(configPath);
  const cursors = await readJson(cursorsPath);
  const queueState = (await readJson(queueStatePath)) || { offset: 0 };
  const uploadThrottle = normalizeUploadState(await readJson(uploadThrottlePath));
  const autoRetry = await readJson(autoRetryPath);

  const queueSize = await safeStatSize(queuePath);
  const offsetBytes = Number(queueState.offset || 0);
  const pendingBytes = Math.max(0, queueSize - offsetBytes);

  const lastNotify = (await safeReadText(notifySignalPath))?.trim() || null;
  const lastOpenclawSync = (await safeReadText(openclawSignalPath))?.trim() || null;
  const lastNotifySpawn = parseEpochMsToIso((await safeReadText(throttlePath))?.trim() || null);

  const codexNotifyRaw = await readCodexNotify(codexConfigPath);
  const notifyConfigured = Array.isArray(codexNotifyRaw) && codexNotifyRaw.length > 0;
  const codexNotify = notifyConfigured ? codexNotifyRaw.map((v) => redactValue(v, home)) : null;
  const everyCodeNotifyRaw = await readEveryCodeNotify(codeConfigPath);
  const everyCodeConfigured = Array.isArray(everyCodeNotifyRaw) && everyCodeNotifyRaw.length > 0;
  const everyCodeNotify = everyCodeConfigured
    ? everyCodeNotifyRaw.map((v) => redactValue(v, home))
    : null;
  const claudeHookCommand = buildClaudeHookCommand(path.join(binDir, "notify.cjs"));
  const claudeHookConfigured = await isClaudeHookConfigured({
    settingsPath: claudeConfigPath,
    hookCommand: claudeHookCommand,
  });
  const geminiHookCommand = buildGeminiHookCommand(path.join(binDir, "notify.cjs"));
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
  const openclawHookState = await probeOpenclawHookState({ home, trackerDir, env: process.env });
  const grokHookState = await probeGrokHookState({ home, trackerDir, env: process.env });

  // Kiro IDE and Kiro CLI sub-path presence — merged under one "kiro" source
  // at token/cost aggregation level; operators need visibility of both
  // sub-paths here for debugging.
  const kiroIdeDevDataDir = path.join(
    home,
    "Library",
    "Application Support",
    "Kiro",
    "User",
    "globalStorage",
    "kiro.kiroagent",
    "dev_data",
  );
  const kiroIdePresent =
    (await safeStatSize(path.join(kiroIdeDevDataDir, "devdata.sqlite"))) > 0 ||
    (await safeStatSize(path.join(kiroIdeDevDataDir, "tokens_generated.jsonl"))) > 0;
  const kiroCliDbPath = resolveKiroCliDbPathInline(process.env, home);
  const kiroCliPresent = require("node:fs").existsSync(kiroCliDbPath);

  const lastSuccessAt = uploadThrottle.lastSuccessMs
    ? new Date(uploadThrottle.lastSuccessMs).toISOString()
    : null;
  const autoRetryAt = parseEpochMsToIso(autoRetry?.retryAtMs);

  return {
    ok: true,
    version: 1,
    generated_at: new Date().toISOString(),
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    paths: {
      tracker_dir: redactValue(trackerDir, home),
      codex_home: redactValue(codexHome, home),
      codex_config: redactValue(codexConfigPath, home),
      code_home: redactValue(codeHome, home),
      code_config: redactValue(codeConfigPath, home),
      claude_config: redactValue(claudeConfigPath, home),
      gemini_config: redactValue(geminiSettingsPath, home),
      opencode_config: redactValue(opencodeConfigDir, home),
      grok_home: redactValue(grokHome, home),
      grok_hooks: redactValue(grokHookState?.grokHooksDir, home),
      grok_handler: redactValue(grokHookState?.handlerPath, home),
      kiro_ide_dev_data: redactValue(kiroIdeDevDataDir, home),
      kiro_cli_db: redactValue(kiroCliDbPath, home),
    },
    kiro: {
      ide_present: kiroIdePresent,
      cli_present: kiroCliPresent,
      cli_approximation:
        "Kiro CLI does not persist explicit token counts (billing is credit-based on Bedrock). Tokens are approximated at 4 chars/token from user prompt chars and assistant response chars. Source rows that came through this path have model='kiro-cli-agent' when the underlying model is unknown (auto-routing); known Bedrock ARNs canonicalize to their short name (e.g. claude-sonnet-4).",
      merge_policy:
        "Kiro IDE and Kiro CLI both emit source='kiro' in queue.jsonl so token, cost, heatmap, and leaderboard aggregations merge transparently. Use this block to distinguish sub-path contributions.",
    },
    config: {
      base_url: typeof config?.baseUrl === "string" ? config.baseUrl : null,
      device_token: config?.deviceToken ? "set" : "unset",
      device_id: maskId(config?.deviceId),
      installed_at: typeof config?.installedAt === "string" ? config.installedAt : null,
    },
    parse: {
      updated_at: typeof cursors?.updatedAt === "string" ? cursors.updatedAt : null,
      file_count:
        cursors?.files && typeof cursors.files === "object"
          ? Object.keys(cursors.files).length
          : null,
    },
    queue: {
      size_bytes: queueSize,
      offset_bytes: offsetBytes,
      pending_bytes: pendingBytes,
      updated_at: typeof queueState.updatedAt === "string" ? queueState.updatedAt : null,
    },
    notify: {
      last_notify: lastNotify,
      last_openclaw_triggered_sync: lastOpenclawSync,
      last_notify_triggered_sync: lastNotifySpawn,
      codex_notify_configured: notifyConfigured,
      codex_notify: codexNotify,
      every_code_notify_configured: everyCodeConfigured,
      every_code_notify: everyCodeNotify,
      claude_hook_configured: claudeHookConfigured,
      gemini_hook_configured: geminiHookConfigured,
      opencode_plugin_configured: opencodePluginConfigured,
      openclaw_session_plugin_configured: Boolean(openclawSessionPluginState?.configured),
      openclaw_session_plugin_linked: Boolean(openclawSessionPluginState?.linked),
      openclaw_session_plugin_enabled: Boolean(openclawSessionPluginState?.enabled),
      openclaw_hook_configured: Boolean(openclawHookState?.configured),
      openclaw_hook_linked: Boolean(openclawHookState?.linked),
      openclaw_hook_enabled: Boolean(openclawHookState?.enabled),
      grok_hook_configured: Boolean(grokHookState?.configured),
      grok_hook_exists: Boolean(grokHookState?.hookExists),
      grok_hook_handler_exists: Boolean(grokHookState?.handlerExists),
      grok_sessions_dir: redactValue(grokHookState?.sessionsDir, home),
    },
    upload: {
      last_success_at: lastSuccessAt,
      next_allowed_after: parseEpochMsToIso(uploadThrottle.nextAllowedAtMs || null),
      backoff_until: parseEpochMsToIso(uploadThrottle.backoffUntilMs || null),
      last_error: uploadThrottle.lastError
        ? {
            at: uploadThrottle.lastErrorAt || null,
            message: redactError(String(uploadThrottle.lastError), home),
          }
        : null,
    },
    auto_retry: autoRetryAt
      ? {
          next_retry_at: autoRetryAt,
          reason: typeof autoRetry?.reason === "string" ? autoRetry.reason : null,
          pending_bytes: Number.isFinite(Number(autoRetry?.pendingBytes))
            ? Math.max(0, Number(autoRetry.pendingBytes))
            : null,
          scheduled_at: typeof autoRetry?.scheduledAt === "string" ? autoRetry.scheduledAt : null,
          source: typeof autoRetry?.source === "string" ? autoRetry.source : null,
        }
      : null,
  };
}

function maskId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 12) return null;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function redactValue(value, home) {
  if (typeof value !== "string") return value;
  if (typeof home !== "string" || home.length === 0) return value;
  const homeNorm = home.endsWith(path.sep) ? home.slice(0, -1) : home;
  return value.startsWith(homeNorm) ? `~${value.slice(homeNorm.length)}` : value;
}

function redactError(message, home) {
  if (typeof message !== "string") return message;
  if (typeof home !== "string" || home.length === 0) return message;
  const homeNorm = home.endsWith(path.sep) ? home.slice(0, -1) : home;
  return message.split(homeNorm).join("~");
}

async function safeStatSize(p) {
  try {
    const st = await fs.stat(p);
    return st && st.isFile() ? st.size : 0;
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

module.exports = { collectTrackerDiagnostics };
