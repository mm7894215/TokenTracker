const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

const GROK_HOOK_FILENAME = "99-tokentracker-usage.json";

function resolveGrokHome(env = process.env) {
  if (env.TOKENTRACKER_GROK_HOME && env.TOKENTRACKER_GROK_HOME.length > 0) {
    return env.TOKENTRACKER_GROK_HOME;
  }
  if (env.GROK_HOME && env.GROK_HOME.length > 0) {
    return env.GROK_HOME;
  }
  return path.join(os.homedir(), ".grok");
}

function resolveGrokHooksDir(env = process.env) {
  return path.join(resolveGrokHome(env), "hooks");
}

function resolveTrackerBinDir(trackerDir) {
  if (!trackerDir) throw new Error("trackerDir is required");
  return path.basename(trackerDir) === "tracker"
    ? path.join(path.dirname(trackerDir), "bin")
    : path.join(trackerDir, "bin");
}

function resolveLegacyTrackerBinDir(trackerDir) {
  if (!trackerDir) throw new Error("trackerDir is required");
  return path.join(trackerDir, "bin");
}

function buildGrokSessionEndHookJson({ notifyGrokHandlerPath }) {
  // The command runs our dedicated handler.
  // We pass the session id and cwd via environment variables that Grok already sets.
  const cmd = `/usr/bin/env node ${shellQuote(notifyGrokHandlerPath)}`;
  return {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: cmd,
              timeout: 60
            }
          ]
        }
      ]
    }
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function ensureGrokHookFiles({
  grokHooksDir,
  trackerDir,
  handlerSource // path to the .cjs template we will write
} = {}) {
  if (!grokHooksDir || !trackerDir) {
    throw new Error("grokHooksDir and trackerDir are required");
  }

  await fs.mkdir(grokHooksDir, { recursive: true });

  const hookPath = path.join(grokHooksDir, GROK_HOOK_FILENAME);
  const binDir = resolveTrackerBinDir(trackerDir);
  await fs.mkdir(binDir, { recursive: true });

  const handlerPath = path.join(binDir, "grok-session-end-hook.cjs");

  // Write the hook JSON (always overwrite to keep command up-to-date if bin path changes)
  const hookJson = buildGrokSessionEndHookJson({ notifyGrokHandlerPath: handlerPath });
  await fs.writeFile(hookPath, JSON.stringify(hookJson, null, 2) + "\n", "utf8");

  // Write (or update) the handler script
  const handlerSourceCode = buildGrokSessionEndHandler({ trackerDir });
  await fs.writeFile(handlerPath, handlerSourceCode, "utf8");

  // Make executable
  try {
    fssync.chmodSync(handlerPath, 0o755);
  } catch {}

  return { hookPath, handlerPath };
}

function buildGrokSessionEndHandler({ trackerDir }) {
  // This is the source of the .cjs that will be executed by the Grok hook.
  // It must be self-contained enough or rely on the copied runtime.
  // For simplicity and reliability we write a small script that:
  // 1. Reads GROK_SESSION_ID + GROK_WORKSPACE_ROOT from env
  // 2. Locates the session metadata files
  // 3. Extracts usage metadata only
  // 4. Writes a signal file under trackerDir that sync.js will pick up on next run

  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const GROK_HOME = process.env.TOKENTRACKER_GROK_HOME || process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const SESSION_ID = process.env.GROK_SESSION_ID;
const WORKSPACE_ROOT = process.env.GROK_WORKSPACE_ROOT || process.cwd();

if (!SESSION_ID) {
  process.exit(0); // nothing to do
}

function encodeGrokCwd(cwd) {
  // Grok uses encodeURIComponent on the full path, replacing / with %2F etc.
  return encodeURIComponent(cwd);
}

const encodedCwd = encodeGrokCwd(WORKSPACE_ROOT);
const sessionDir = path.join(GROK_HOME, 'sessions', encodedCwd, SESSION_ID);
const signalsPath = path.join(sessionDir, 'signals.json');
const summaryPath = path.join(sessionDir, 'summary.json');
const updatesPath = path.join(sessionDir, 'updates.jsonl');

let signals = {};
try {
  const raw = fs.readFileSync(signalsPath, 'utf8');
  signals = JSON.parse(raw);
} catch (err) {
  signals = {};
}
if (!signals || typeof signals !== 'object') {
  signals = {};
}

const summary = (() => {
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    return {};
  }
})();

function toNonNegativeFiniteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function timestampToIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const millis = value < 10000000000 ? value * 1000 : value;
    const dt = new Date(millis);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[0-9]+(?:\\.[0-9]+)?$/.test(trimmed)) return timestampToIso(Number(trimmed));
    const dt = new Date(trimmed);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  return null;
}

async function readUpdateTelemetry(filePath) {
  let totalTokens = 0;
  let lastEventId = null;
  let lastEventTimestamp = null;
  let lineNumber = 0;

  try {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        lineNumber += 1;
        if (!line || !line.trim()) continue;
        let record = null;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const meta = record && record.params && record.params._meta ? record.params._meta : record && record._meta;
        if (!meta || typeof meta !== 'object') continue;
        const nextTotal = toNonNegativeFiniteNumber(meta.totalTokens);
        if (nextTotal <= 0) continue;
        totalTokens = Math.max(totalTokens, nextTotal);
        lastEventId = meta.eventId != null ? String(meta.eventId) : String(lineNumber);
        lastEventTimestamp =
          timestampToIso(meta.agentTimestampMs) ||
          timestampToIso(meta.timestampMs) ||
          timestampToIso(record.timestamp_ms) ||
          timestampToIso(record.timestamp) ||
          lastEventTimestamp;
      }
    } finally {
      rl.close();
    }
  } catch {
    return { totalTokens, lastEventId, lastEventTimestamp };
  }
  return { totalTokens, lastEventId, lastEventTimestamp };
}

async function main() {
const contextTokensUsed = toNonNegativeFiniteNumber(signals.contextTokensUsed ?? signals.totalTokens);
const totalTokensBeforeCompaction = toNonNegativeFiniteNumber(signals.totalTokensBeforeCompaction);
const signalTotalTokens = totalTokensBeforeCompaction + contextTokensUsed;
const updateTelemetry = await readUpdateTelemetry(updatesPath);
const totalTokens = Math.max(updateTelemetry.totalTokens, signalTotalTokens);
const messageCount = toNonNegativeFiniteNumber(signals.assistantMessageCount || signals.num_chat_messages);
const model = signals.primaryModelId || (Array.isArray(signals.modelsUsed) ? signals.modelsUsed[0] : 'grok-build');
const lastActive = signals.lastActiveAt || updateTelemetry.lastEventTimestamp || summary.updated_at || new Date().toISOString();

if (totalTokens <= 0) {
  process.exit(0);
}

// Write a signal that the TokenTracker sync / local API can pick up
const trackerDir = ${JSON.stringify(trackerDir)};
const signalDir = trackerDir;
try { fs.mkdirSync(signalDir, { recursive: true }); } catch {}

const signal = {
  source: 'grok',
  sessionId: SESSION_ID,
  cwd: WORKSPACE_ROOT,
  model,
  totalTokens,
  contextTokensUsed,
  totalTokensBeforeCompaction,
  messageCount,
  lastActive,
  sessionDir,
  updatesPath,
  signalsPath,
  summaryPath,
  lastEventId: updateTelemetry.lastEventId,
  lastEventTimestamp: updateTelemetry.lastEventTimestamp,
  capturedAt: new Date().toISOString()
};

const signalPath = path.join(signalDir, 'grok-last-session.json');
fs.writeFileSync(signalPath, JSON.stringify(signal, null, 2) + '\\n');

// Also touch a file so any running serve instance can react (optional)
try {
  fs.writeFileSync(path.join(signalDir, 'grok-session-end.trigger'), Date.now().toString());
} catch {}

process.exit(0);
}

main().catch(() => process.exit(0));
`;
}

async function probeGrokHookState({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const grokHooksDir = resolveGrokHooksDir(env);
  const hookPath = path.join(grokHooksDir, GROK_HOOK_FILENAME);
  const binDir = resolveTrackerBinDir(trackerDir);
  const handlerPath = path.join(binDir, "grok-session-end-hook.cjs");
  const legacyHandlerPath = path.join(resolveLegacyTrackerBinDir(trackerDir), "grok-session-end-hook.cjs");

  const hookExists = fssync.existsSync(hookPath);
  const handlerExists = fssync.existsSync(handlerPath) || fssync.existsSync(legacyHandlerPath);

  let configured = false;
  if (hookExists) {
    try {
      const content = fssync.readFileSync(hookPath, "utf8");
      const json = JSON.parse(content);
      configured = Boolean(json?.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command?.includes("grok-session-end-hook"));
    } catch {}
  }

  const sessionsDir = path.join(resolveGrokHome(env), "sessions");
  const hasSessions = fssync.existsSync(sessionsDir);

  return {
    configured,
    hookExists,
    handlerExists,
    grokHome: resolveGrokHome(env),
    grokHooksDir,
    hookPath,
    handlerPath,
    legacyHandlerPath,
    hasGrokInstall: fssync.existsSync(path.join(resolveGrokHome(env), "bin", "grok")) || hasSessions,
    sessionsDir
  };
}

async function upsertGrokHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const grokHooksDir = resolveGrokHooksDir(env);
  const result = await ensureGrokHookFiles({ grokHooksDir, trackerDir });

  const state = await probeGrokHookState({ home, trackerDir, env });
  return {
    ...state,
    changed: true,
    ...result
  };
}

async function removeGrokHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const grokHooksDir = resolveGrokHooksDir(env);
  const hookPath = path.join(grokHooksDir, GROK_HOOK_FILENAME);
  const binDir = resolveTrackerBinDir(trackerDir);
  const handlerPath = path.join(binDir, "grok-session-end-hook.cjs");
  const legacyHandlerPath = path.join(resolveLegacyTrackerBinDir(trackerDir), "grok-session-end-hook.cjs");

  let removed = false;
  try {
    if (fssync.existsSync(hookPath)) {
      fssync.unlinkSync(hookPath);
      removed = true;
    }
  } catch {}
  try {
    if (fssync.existsSync(handlerPath)) {
      fssync.unlinkSync(handlerPath);
      removed = true;
    }
  } catch {}
  if (legacyHandlerPath !== handlerPath) {
    try {
      if (fssync.existsSync(legacyHandlerPath)) {
        fssync.unlinkSync(legacyHandlerPath);
        removed = true;
      }
    } catch {}
  }

  return { removed, hookPath, handlerPath, legacyHandlerPath };
}

module.exports = {
  resolveGrokHome,
  resolveGrokHooksDir,
  buildGrokSessionEndHookJson,
  upsertGrokHook,
  probeGrokHookState,
  removeGrokHook,
  GROK_HOOK_FILENAME,
  buildGrokSessionEndHandler
};
