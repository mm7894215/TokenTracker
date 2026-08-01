"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

// Reuse the passive scanner's path resolvers so init/status/uninstall target
// the same OMP installation that sync scans (HOME overrides, PI_CONFIG_DIR,
// PI_CODING_AGENT_DIR ownership, ~ expansion, Windows/WSL paths).
const {
  resolveOmpHome,
  resolveOmpAgentDir,
} = require("./rollout");

const EXTENSION_FILENAME = "tokentracker-notify.ts";
const MARKER = "// @tokentracker-managed-omp-extension";

/**
 * Test-only injection points for deterministic race repros.
 * Production code never sets these; tests may assign async functions:
 * - beforeExclusiveCreate(extensionPath)
 * - beforeManagedWrite(extensionPath, identity)
 * - beforeUnlink(extensionPath, identity)
 * - afterStagingRename(extensionPath, stagingPath)
 */
const _testHooks = {
  beforeExclusiveCreate: null,
  beforeManagedWrite: null,
  beforeUnlink: null,
  afterStagingRename: null,
};

function resolveOmpExtensionsDir(env = process.env) {
  const agentDir = resolveOmpAgentDir(env);
  if (!agentDir) return null;
  return path.join(agentDir, "extensions");
}

function resolveTrackerBinDir(trackerDir) {
  if (!trackerDir) throw new Error("trackerDir is required");
  return path.basename(trackerDir) === "tracker"
    ? path.join(path.dirname(trackerDir), "bin")
    : path.join(trackerDir, "bin");
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

function fileIdentity(stat) {
  if (!stat) return null;
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

async function pathIdentity(filePath) {
  try {
    return fileIdentity(await fs.stat(filePath));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function probeOmpHookState({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const agentDir = resolveOmpAgentDir(env);
  const extensionsDir = resolveOmpExtensionsDir(env);
  const extensionPath = extensionsDir
    ? path.join(extensionsDir, EXTENSION_FILENAME)
    : null;
  const sessionsDir = agentDir ? path.join(agentDir, "sessions") : null;
  const ompPresent = Boolean(
    (agentDir && fssync.existsSync(agentDir)) ||
      (sessionsDir && fssync.existsSync(sessionsDir)),
  );

  let configured = false;
  let managed = false;
  let exists = false;
  if (extensionPath && fssync.existsSync(extensionPath)) {
    exists = true;
    try {
      const content = await fs.readFile(extensionPath, "utf8");
      managed = isManagedOmpExtension(content);
      // Treat any tokentracker-notify extension as configured for status UX.
      // Ownership decisions (overwrite/remove) still require the exact MARKER.
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

/**
 * Write managed source through an already-opened handle, then confirm the
 * directory entry still refers to that same inode (so a path replacement
 * during the write cannot be reported as success against a user file).
 */
async function writeManagedThroughHandle(handle, extensionPath, source, openedIdentity) {
  if (typeof _testHooks.beforeManagedWrite === "function") {
    await _testHooks.beforeManagedWrite(extensionPath, openedIdentity);
  }

  let pathIdBefore;
  try {
    pathIdBefore = await pathIdentity(extensionPath);
  } catch (err) {
    return {
      written: false,
      skippedReason: "identity-check-failed",
      error: String(err?.message || err),
    };
  }
  if (!sameFileIdentity(pathIdBefore, openedIdentity)) {
    return { written: false, skippedReason: "identity-changed" };
  }

  try {
    await handle.truncate(0);
    const sourceBytes = Buffer.from(source, "utf8");
    let offset = 0;
    while (offset < sourceBytes.length) {
      const { bytesWritten } = await handle.write(
        sourceBytes,
        offset,
        sourceBytes.length - offset,
        offset,
      );
      if (bytesWritten <= 0) {
        throw new Error("Failed to write managed oh-my-pi extension");
      }
      offset += bytesWritten;
    }
  } catch (err) {
    return {
      written: false,
      skippedReason: "extension-write-failed",
      error: String(err?.message || err),
    };
  }

  let pathIdAfter;
  try {
    pathIdAfter = await pathIdentity(extensionPath);
  } catch (err) {
    return {
      written: false,
      skippedReason: "identity-check-failed",
      error: String(err?.message || err),
    };
  }
  if (!sameFileIdentity(pathIdAfter, openedIdentity)) {
    // Path now points elsewhere (or is gone). The handle write hit the
    // original managed inode only; do not claim ownership of the path.
    return { written: false, skippedReason: "identity-changed" };
  }
  return { written: true };
}

async function upsertOmpHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");
  const binDir = resolveTrackerBinDir(trackerDir);
  const notifyPath = path.join(binDir, "notify.cjs");
  const extensionsDir = resolveOmpExtensionsDir(env);
  if (!extensionsDir) {
    return {
      written: false,
      skippedReason: "omp-agent-dir-unresolved",
      extensionPath: null,
      notifyPath,
    };
  }
  const extensionPath = path.join(extensionsDir, EXTENSION_FILENAME);
  const source = buildOmpNotifyExtensionSource({ notifyPath });

  await fs.mkdir(extensionsDir, { recursive: true });

  if (typeof _testHooks.beforeExclusiveCreate === "function") {
    await _testHooks.beforeExclusiveCreate(extensionPath);
  }

  // Create path: exclusive open so a concurrent user create cannot be clobbered.
  try {
    const createHandle = await fs.open(extensionPath, "wx");
    try {
      await createHandle.writeFile(source, "utf8");
    } finally {
      await createHandle.close();
    }
    const state = await probeOmpHookState({ home, trackerDir, env });
    return {
      written: true,
      extensionPath,
      notifyPath,
      state,
    };
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      return {
        written: false,
        skippedReason: "extension-write-failed",
        error: String(err?.message || err),
        extensionPath,
        notifyPath,
      };
    }
    // Fall through: path exists — only rewrite if still our managed inode.
  }

  // Update path: open by path, verify marker on the opened inode, mutate only
  // that inode, and refuse if the directory entry changes identity mid-flight.
  let handle;
  try {
    handle = await fs.open(extensionPath, "r+");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Lost the race to a delete; retry exclusive create once without the
      // create-hook (hook already ran for the first attempt).
      try {
        const createHandle = await fs.open(extensionPath, "wx");
        try {
          await createHandle.writeFile(source, "utf8");
        } finally {
          await createHandle.close();
        }
        const state = await probeOmpHookState({ home, trackerDir, env });
        return { written: true, extensionPath, notifyPath, state };
      } catch (retryErr) {
        if (retryErr && retryErr.code === "EEXIST") {
          // Concurrent create won; re-enter ownership check below.
          try {
            handle = await fs.open(extensionPath, "r+");
          } catch (openErr) {
            return {
              written: false,
              skippedReason: "extension-read-failed",
              error: String(openErr?.message || openErr),
              extensionPath,
              notifyPath,
            };
          }
        } else {
          return {
            written: false,
            skippedReason: "extension-write-failed",
            error: String(retryErr?.message || retryErr),
            extensionPath,
            notifyPath,
          };
        }
      }
    } else {
      return {
        written: false,
        skippedReason: "extension-read-failed",
        error: String(err?.message || err),
        extensionPath,
        notifyPath,
      };
    }
  }

  try {
    const existing = await handle.readFile("utf8");
    if (!isManagedOmpExtension(existing)) {
      return {
        written: false,
        skippedReason: "unmanaged-extension-present",
        extensionPath,
        notifyPath,
      };
    }

    const openedIdentity = fileIdentity(await handle.stat());
    const writeResult = await writeManagedThroughHandle(
      handle,
      extensionPath,
      source,
      openedIdentity,
    );
    if (!writeResult.written) {
      return {
        written: false,
        skippedReason: writeResult.skippedReason,
        ...(writeResult.error ? { error: writeResult.error } : {}),
        extensionPath,
        notifyPath,
      };
    }

    const state = await probeOmpHookState({ home, trackerDir, env });
    return {
      written: true,
      extensionPath,
      notifyPath,
      state,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Restore without replacing a concurrent destination; keep staging on failure.
async function restoreStagedExtension(stagingPath, extensionPath) {
  try {
    await fs.copyFile(stagingPath, extensionPath, fssync.constants.COPYFILE_EXCL);
  } catch (error) {
    return { restored: false, error };
  }

  try {
    await fs.unlink(stagingPath);
  } catch (error) {
    return { restored: true, staleStaging: true, error };
  }

  return { restored: true };
}

async function removeOmpHook({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const extensionsDir = resolveOmpExtensionsDir(env);
  if (!extensionsDir) {
    return { removed: false, skippedReason: "omp-agent-dir-unresolved", extensionPath: null };
  }
  const extensionPath = path.join(extensionsDir, EXTENSION_FILENAME);

  // Peek first so the common unmanaged/missing cases do not thrash the path.
  try {
    const peek = await fs.readFile(extensionPath, "utf8");
    if (!isManagedOmpExtension(peek)) {
      return { removed: false, skippedReason: "unmanaged", extensionPath };
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { removed: false, skippedReason: "missing", extensionPath };
    }
    return {
      removed: false,
      skippedReason: "extension-read-failed",
      error: String(err?.message || err),
      extensionPath,
    };
  }

  if (typeof _testHooks.beforeUnlink === "function") {
    await _testHooks.beforeUnlink(extensionPath, null);
  }

  // Atomically claim the directory entry via rename. The staged inode remains
  // private until restoreStagedExtension copies it back without replacing a
  // concurrent replacement at the original path.
  const stagingPath = path.join(
    extensionsDir,
    `.${EXTENSION_FILENAME}.tokentracker-removing-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  try {
    await fs.rename(extensionPath, stagingPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { removed: false, skippedReason: "missing", extensionPath };
    }
    return {
      removed: false,
      skippedReason: "unlink-failed",
      error: String(err?.message || err),
      extensionPath,
    };
  }

  if (typeof _testHooks.afterStagingRename === "function") {
    await _testHooks.afterStagingRename(extensionPath, stagingPath);
  }

  let stagedContent;
  try {
    stagedContent = await fs.readFile(stagingPath, "utf8");
  } catch (err) {
    // Best-effort restore if we cannot inspect what we claimed.
    const restoreResult = await restoreStagedExtension(stagingPath, extensionPath);
    return {
      removed: false,
      skippedReason: "extension-read-failed",
      error: String(err?.message || err),
      extensionPath,
      ...(restoreResult.staleStaging
        ? {
            staleStaging: true,
            stagedPath: stagingPath,
            stagingError: String(restoreResult.error?.message || restoreResult.error),
          }
        : restoreResult.restored
          ? {}
          : { stagedPath: stagingPath }),
    };
  }

  if (!isManagedOmpExtension(stagedContent)) {
    // Restored user/replacement file under the original path.
    const restoreResult = await restoreStagedExtension(stagingPath, extensionPath);
    if (!restoreResult.restored) {
      // If the original path was recreated, leave the staged file for the user.
      return {
        removed: false,
        skippedReason: "identity-changed",
        error: String(restoreResult.error?.message || restoreResult.error),
        extensionPath,
        stagedPath: stagingPath,
      };
    }
    return {
      removed: false,
      skippedReason: "identity-changed",
      extensionPath,
      ...(restoreResult.staleStaging
        ? {
            staleStaging: true,
            stagedPath: stagingPath,
            stagingError: String(restoreResult.error?.message || restoreResult.error),
          }
        : {}),
    };
  }

  try {
    await fs.unlink(stagingPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { removed: true, extensionPath };
    }
    // Restore the managed file so uninstall does not leave a silent orphan
    // under a temp name when the final delete is blocked.
    const restoreResult = await restoreStagedExtension(stagingPath, extensionPath);
    return {
      removed: false,
      skippedReason: "unlink-failed",
      error: String(err?.message || err),
      extensionPath,
      ...(restoreResult.staleStaging
        ? {
            staleStaging: true,
            stagedPath: stagingPath,
            stagingError: String(restoreResult.error?.message || restoreResult.error),
          }
        : restoreResult.restored
          ? {}
          : { stagedPath: stagingPath }),
    };
  }

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
  _testHooks,
};
