"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

const EXTENSION_FILENAME = "tokentracker-notify.ts";
const MARKER = "// @tokentracker-managed-omp-extension";

function resolveOmpHome(env = process.env) {
  if (env.TOKENTRACKER_OMP_HOME && env.TOKENTRACKER_OMP_HOME.length > 0) {
    return env.TOKENTRACKER_OMP_HOME;
  }
  if (env.OMP_HOME && env.OMP_HOME.length > 0) {
    return env.OMP_HOME;
  }
  // Align with oh-my-pi default agent dir (~/.omp/agent) parent.
  return path.join(os.homedir(), ".omp");
}

function resolveOmpAgentDir(env = process.env) {
  if (env.TOKENTRACKER_OMP_AGENT_DIR && env.TOKENTRACKER_OMP_AGENT_DIR.length > 0) {
    return env.TOKENTRACKER_OMP_AGENT_DIR;
  }
  if (env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.length > 0) {
    // Shared env with pi; only treat as omp when ~/.omp exists or override says so.
    const candidate = env.PI_CODING_AGENT_DIR;
    if (candidate.includes(`${path.sep}.omp${path.sep}`) || candidate.endsWith(`${path.sep}.omp`)) {
      return candidate;
    }
  }
  return path.join(resolveOmpHome(env), "agent");
}

function resolveOmpExtensionsDir(env = process.env) {
  return path.join(resolveOmpAgentDir(env), "extensions");
}

function resolveTrackerBinDir(trackerDir) {
  if (!trackerDir) throw new Error("trackerDir is required");
  return path.basename(trackerDir) === "tracker"
    ? path.join(path.dirname(trackerDir), "bin")
    : path.join(trackerDir, "bin");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Extension source written into ~/.omp/agent/extensions/tokentracker-notify.ts.
 * Uses require()-style node builtins so omp's extension rewriter can parse it.
 * Spawns notify.cjs --source=omp (already in AUTO_SYNC_SOURCES) after turns.
 */
function buildOmpNotifyExtensionSource({ notifyPath }) {
  const notifyLiteral = JSON.stringify(notifyPath);
  return `${MARKER}
// TokenTracker notify bridge for oh-my-pi (omp).
// Passive session scanning still works without this file; the extension only
// makes local dashboard refresh near-real-time after each agent turn.
// Managed by TokenTracker init/uninstall — do not hand-edit the marker line.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SOURCE = "omp";
const MIN_INTERVAL_MS = 12_000;
const MANAGED_NOTIFY = ${notifyLiteral};

let lastSpawnAt = 0;
let pendingTimer = null;
let warnedMissing = false;

function resolveNotifyPath() {
  const candidates = [];
  if (process.env.TOKENTRACKER_NOTIFY) candidates.push(process.env.TOKENTRACKER_NOTIFY);
  if (MANAGED_NOTIFY) candidates.push(MANAGED_NOTIFY);
  candidates.push(path.join(os.homedir(), ".tokentracker", "bin", "notify.cjs"));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

function spawnNotify() {
  const notifyPath = resolveNotifyPath();
  if (!notifyPath) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[tokentracker-notify] notify.cjs not found; expected ~/.tokentracker/bin/notify.cjs",
      );
    }
    return;
  }

  const now = Date.now();
  if (now - lastSpawnAt < MIN_INTERVAL_MS) {
    if (pendingTimer == null) {
      const wait = Math.max(MIN_INTERVAL_MS - (now - lastSpawnAt), 50);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        spawnNotify();
      }, wait);
      if (typeof pendingTimer.unref === "function") pendingTimer.unref();
    }
    return;
  }
  lastSpawnAt = now;
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  try {
    const child = spawn(process.execPath, [notifyPath, "--source=" + SOURCE], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (err) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[tokentracker-notify] failed to spawn notify:",
        err && err.message ? err.message : String(err),
      );
    }
  }
}

export default function (pi) {
  pi.on("turn_end", () => {
    spawnNotify();
  });

  pi.on("agent_end", () => {
    spawnNotify();
  });

  pi.on("session_shutdown", () => {
    lastSpawnAt = 0;
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    spawnNotify();
  });
}
`;
}

function isManagedOmpExtension(content) {
  return typeof content === "string" && content.includes(MARKER);
}

async function probeOmpHookState({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const agentDir = resolveOmpAgentDir(env);
  const extensionsDir = resolveOmpExtensionsDir(env);
  const extensionPath = path.join(extensionsDir, EXTENSION_FILENAME);
  const sessionsDir = path.join(agentDir, "sessions");
  const ompPresent = fssync.existsSync(agentDir) || fssync.existsSync(sessionsDir);

  let configured = false;
  let managed = false;
  let exists = false;
  if (fssync.existsSync(extensionPath)) {
    exists = true;
    try {
      const content = await fs.readFile(extensionPath, "utf8");
      managed = isManagedOmpExtension(content);
      // Treat any tokentracker-notify extension as configured for status UX.
      configured = managed || /notify\.cjs|--source=omp|tokentracker/i.test(content);
    } catch {
      configured = false;
    }
  }

  return {
    ompPresent,
    agentDir,
    extensionsDir,
    extensionPath,
    exists,
    configured,
    managed,
    sessionsDir,
  };
}

async function upsertOmpHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");
  const binDir = resolveTrackerBinDir(trackerDir);
  const notifyPath = path.join(binDir, "notify.cjs");
  const extensionsDir = resolveOmpExtensionsDir(env);
  const extensionPath = path.join(extensionsDir, EXTENSION_FILENAME);

  await fs.mkdir(extensionsDir, { recursive: true });

  // Don't clobber a user-authored extension that isn't ours.
  if (fssync.existsSync(extensionPath)) {
    try {
      const existing = await fs.readFile(extensionPath, "utf8");
      if (existing && !isManagedOmpExtension(existing) && !/tokentracker/i.test(existing)) {
        return {
          written: false,
          skippedReason: "unmanaged-extension-present",
          extensionPath,
          notifyPath,
        };
      }
    } catch {
      // overwrite if unreadable
    }
  }

  const source = buildOmpNotifyExtensionSource({ notifyPath });
  await fs.writeFile(extensionPath, source, "utf8");

  const state = await probeOmpHookState({ home, trackerDir, env });
  return {
    written: true,
    extensionPath,
    notifyPath,
    state,
  };
}

async function removeOmpHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const extensionPath = path.join(resolveOmpExtensionsDir(env), EXTENSION_FILENAME);
  if (!fssync.existsSync(extensionPath)) {
    return { removed: false, skippedReason: "missing", extensionPath };
  }
  try {
    const content = await fs.readFile(extensionPath, "utf8");
    if (!isManagedOmpExtension(content) && !/tokentracker/i.test(content)) {
      return { removed: false, skippedReason: "unmanaged", extensionPath };
    }
  } catch {
    // fall through to attempt remove
  }
  await fs.unlink(extensionPath).catch(() => {});
  return { removed: true, extensionPath };
}

module.exports = {
  EXTENSION_FILENAME,
  MARKER,
  resolveOmpHome,
  resolveOmpAgentDir,
  resolveOmpExtensionsDir,
  buildOmpNotifyExtensionSource,
  isManagedOmpExtension,
  probeOmpHookState,
  upsertOmpHook,
  removeOmpHook,
};
