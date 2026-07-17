const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, content, { encoding: "utf8" });
  await fs.rename(tmp, filePath);
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

async function readJsonStrict(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { status: "ok", value: JSON.parse(raw), error: null };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return { status: "missing", value: null, error: err };
    }
    if (err && err.name === "SyntaxError") {
      return { status: "invalid", value: null, error: err };
    }
    return { status: "error", value: null, error: err };
  }
}

async function writeJson(filePath, obj) {
  await writeFileAtomic(filePath, JSON.stringify(obj, null, 2) + "\n");
}

async function chmod600IfPossible(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
  } catch (_e) {}
}

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_HEARTBEAT_MS = 30 * 1000;
const MAX_RECLAIM_DEPTH = 4;

function parseLockOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    const token = typeof parsed?.token === "string" ? parsed.token : null;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !token) return null;
    return { pid, token };
  } catch (_e) {
    return null;
  }
}

function heartbeatPathFor(lockPath, token) {
  const tokenDigest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  return `${lockPath}.heartbeat.${tokenDigest}`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // errors are treated conservatively so a live lock is never reclaimed.
    return true;
  }
}

async function existingLockCanBeReclaimed(lockPath) {
  let lockHandle = null;
  try {
    // Inspect one opened inode instead of stat-ing a path and then reading
    // that path. The latter is a TOCTOU window and is also unsafe if a
    // concurrent reclaimer replaces the lock between the two operations.
    lockHandle = await fs.open(lockPath, "r");
    const [stat, raw] = await Promise.all([
      lockHandle.stat(),
      lockHandle.readFile({ encoding: "utf8" }),
    ]);
    const owner = parseLockOwner(raw);
    if (owner) {
      if (!isProcessAlive(owner.pid)) return true;

      // New leases keep a token-specific heartbeat separate from the owner
      // file. This lets a PID that has since been reused be recognized as an
      // abandoned lease without reclaiming a live, long-running sync whose
      // heartbeat is still fresh. Locks from before heartbeat support retain
      // the conservative live-PID behavior.
      let heartbeatHandle = null;
      try {
        heartbeatHandle = await fs.open(heartbeatPathFor(lockPath, owner.token), "r");
        const heartbeat = await heartbeatHandle.stat();
        return Date.now() - heartbeat.mtimeMs > LOCK_STALE_MS;
      } catch (_e) {
        return false;
      } finally {
        await heartbeatHandle?.close().catch(() => {});
      }
    }
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch (e) {
    // The lock disappeared between open and inspection, so retry acquisition.
    if (e?.code === "ENOENT") return true;
    return false;
  } finally {
    await lockHandle?.close().catch(() => {});
  }
}

function startLockHeartbeat(handle, heartbeatHandle) {
  const beat = async () => {
    try {
      const now = new Date();
      await Promise.all([
        handle.utimes(now, now),
        heartbeatHandle.utimes(now, now),
      ]);
    } catch (_e) {
      // A failed heartbeat makes the lease eligible for bounded stale
      // reclamation. The owning sync will still finish or release normally.
    }
  };
  const timer = setInterval(() => {
    void beat();
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

async function releaseOwnedLock(
  lockPath,
  handle,
  heartbeatHandle,
  heartbeatTimer,
  token,
) {
  clearInterval(heartbeatTimer);
  await handle.close().catch(() => {});
  await heartbeatHandle?.close().catch(() => {});
  try {
    const owner = parseLockOwner(await fs.readFile(lockPath, "utf8"));
    if (owner?.token === token) {
      await fs.unlink(lockPath).catch(() => {});
      await fs.unlink(heartbeatPathFor(lockPath, token)).catch(() => {});
    }
  } catch (_e) {}
}

async function openLock(
  lockPath,
  {
    quietIfLocked = false,
    beforeReclaim = null,
    reclaimDepth = 0,
  } = {},
) {
  try {
    const handle = await fs.open(lockPath, "wx");
    const token = crypto.randomUUID();
    const heartbeatPath = heartbeatPathFor(lockPath, token);
    let heartbeatHandle = null;
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + "\n",
        "utf8",
      );
      heartbeatHandle = await fs.open(heartbeatPath, "wx");
      await heartbeatHandle.writeFile(`${token}\n`, "utf8");
      const heartbeatTimer = startLockHeartbeat(handle, heartbeatHandle);
      return {
        async release() {
          await releaseOwnedLock(
            lockPath,
            handle,
            heartbeatHandle,
            heartbeatTimer,
            token,
          );
        },
      };
    } catch (e) {
      await heartbeatHandle?.close().catch(() => {});
      await fs.unlink(heartbeatPath).catch(() => {});
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e && e.code === "EEXIST") {
      if (await existingLockCanBeReclaimed(lockPath)) {
        if (typeof beforeReclaim === "function") {
          await beforeReclaim({ lockPath });
        }
        if (reclaimDepth >= MAX_RECLAIM_DEPTH) return null;

        // Serialize all reclaimers before re-checking the target. A stale
        // check can be shared by many contenders; only the holder of this
        // atomic guard may move the old lease out of the way.
        const reclaimGuard = await openLock(`${lockPath}.reclaim`, {
          quietIfLocked: true,
          reclaimDepth: reclaimDepth + 1,
        });
        if (!reclaimGuard) return null;

        let quarantinePath = null;
        try {
          // Re-check while holding the guard. A competing reclaimer may have
          // already replaced the target since our initial stale inspection.
          if (!(await existingLockCanBeReclaimed(lockPath))) return null;

          quarantinePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
          try {
            await fs.rename(lockPath, quarantinePath);
          } catch (renameError) {
            if (renameError?.code === "ENOENT") {
              return openLock(lockPath, { quietIfLocked, reclaimDepth });
            }
            if (!quietIfLocked) {
              process.stdout.write("Another sync is already running.\n");
            }
            return null;
          }

          const staleOwner = parseLockOwner(
            await fs.readFile(quarantinePath, "utf8").catch(() => ""),
          );
          if (staleOwner) {
            // The heartbeat name contains the old token, so it cannot belong
            // to a replacement lease created after the atomic rename.
            await fs.unlink(heartbeatPathFor(lockPath, staleOwner.token)).catch(() => {});
          }
          return await openLock(lockPath, { quietIfLocked, reclaimDepth });
        } finally {
          if (quarantinePath) await fs.unlink(quarantinePath).catch(() => {});
          await reclaimGuard.release();
        }
      }
      if (!quietIfLocked) {
        process.stdout.write("Another sync is already running.\n");
      }
      return null;
    }
    throw e;
  }
}

module.exports = {
  ensureDir,
  writeFileAtomic,
  readJson,
  readJsonStrict,
  writeJson,
  chmod600IfPossible,
  openLock,
};
