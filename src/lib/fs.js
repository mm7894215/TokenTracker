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
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const owner = parseLockOwner(raw);
    if (owner) return !isProcessAlive(owner.pid);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch (e) {
    // The lock disappeared between open and inspection, so retry acquisition.
    if (e?.code === "ENOENT") return true;
    return false;
  }
}

async function releaseOwnedLock(lockPath, handle, token) {
  await handle.close().catch(() => {});
  try {
    const owner = parseLockOwner(await fs.readFile(lockPath, "utf8"));
    if (owner?.token === token) {
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch (_e) {}
}

async function openLock(lockPath, { quietIfLocked } = {}) {
  try {
    const handle = await fs.open(lockPath, "wx");
    const token = crypto.randomUUID();
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + "\n",
        "utf8",
      );
    } catch (e) {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw e;
    }
    return {
      async release() {
        await releaseOwnedLock(lockPath, handle, token);
      },
    };
  } catch (e) {
    if (e && e.code === "EEXIST") {
      if (await existingLockCanBeReclaimed(lockPath)) {
        try {
          await fs.unlink(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") {
            if (!quietIfLocked) {
              process.stdout.write("Another sync is already running.\n");
            }
            return null;
          }
        }
        return openLock(lockPath, { quietIfLocked });
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
