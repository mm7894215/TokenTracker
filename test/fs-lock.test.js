const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { openLock } = require("../src/lib/fs");
const { acquireSyncLock } = require("../src/commands/sync");

async function withLockPath(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-lock-"));
  try {
    await fn(path.join(directory, "sync.lock"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("sync lock records its live owner and releases its own lease", async () => {
  await withLockPath(async (lockPath) => {
    const lock = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(lock);

    const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.token, "string");
    assert.ok(owner.token.length > 0);

    assert.equal(await openLock(lockPath, { quietIfLocked: true }), null);
    await lock.release();
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  });
});

test("sync lock immediately reclaims a fresh lease owned by a dead process", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "abandoned",
        createdAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );

    const lock = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(lock);
    const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, "abandoned");
    await lock.release();
  });
});

test("sync lock reclaims a reused PID only after its heartbeat expires", async () => {
  await withLockPath(async (lockPath) => {
    const token = "reused-pid";
    const tokenDigest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const heartbeatPath = `${lockPath}.heartbeat.${tokenDigest}`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(heartbeatPath, `${token}\n`, "utf8");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(heartbeatPath, old, old);

    const lock = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(lock);
    await lock.release();
  });
});

test("sync lock never reclaims an old lease while its owner is still alive", async () => {
  await withLockPath(async (lockPath) => {
    const active = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(active);

    const old = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(lockPath, old, old);
    assert.equal(await openLock(lockPath, { quietIfLocked: true }), null);

    await active.release();
  });
});

test("sync lock keeps fresh legacy locks but reclaims them after the fallback age", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(lockPath, "", "utf8");
    assert.equal(await openLock(lockPath, { quietIfLocked: true }), null);

    const old = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(lockPath, old, old);
    const lock = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(lock);
    await lock.release();
  });
});

test("an obsolete owner cannot remove a replacement lock", async () => {
  await withLockPath(async (lockPath) => {
    const first = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(first);
    await fs.unlink(lockPath);

    const replacement = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(replacement);
    const replacementOwner = await fs.readFile(lockPath, "utf8");

    await first.release();
    assert.equal(await fs.readFile(lockPath, "utf8"), replacementOwner);
    await replacement.release();
  });
});

test("release and stale reclaim serialize ownership before replacement", async () => {
  await withLockPath(async (lockPath) => {
    let releaseValidated;
    const validationReached = new Promise((resolve) => {
      releaseValidated = resolve;
    });
    let allowRelease;
    const releaseBarrier = new Promise((resolve) => {
      allowRelease = resolve;
    });

    const active = await openLock(lockPath, {
      quietIfLocked: true,
      beforeReleaseUnlink: async () => {
        releaseValidated();
        await releaseBarrier;
      },
    });
    assert.ok(active);

    const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ...owner, pid: 2_147_483_647 }) + "\n",
      "utf8",
    );

    const releasing = active.release();
    await validationReached;

    // This contender classifies the old lease as stale, but it cannot move or
    // replace the lease while release holds the shared transition guard.
    const blockedReclaimer = await openLock(lockPath, { quietIfLocked: true });
    assert.equal(blockedReclaimer, null);

    allowRelease();
    await releasing;

    const replacement = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(replacement);
    const replacementOwner = await fs.readFile(lockPath, "utf8");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await fs.readFile(lockPath, "utf8"), replacementOwner);
    await replacement.release();
  });
});

test("two stale reclaimers cannot both acquire the same lock", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "abandoned-concurrent",
        createdAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );

    let classified = 0;
    let releaseBarrier;
    const bothClassified = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    const beforeReclaim = async () => {
      classified += 1;
      if (classified === 2) releaseBarrier();
      await bothClassified;
    };

    const locks = await Promise.all([
      openLock(lockPath, { quietIfLocked: true, beforeReclaim }),
      openLock(lockPath, { quietIfLocked: true, beforeReclaim }),
    ]);
    assert.equal(locks.filter(Boolean).length, 1);
    for (const lock of locks) await lock?.release();
  });
});

test("notify sync waits for the active owner and acquires the released lock", async () => {
  await withLockPath(async (lockPath) => {
    const active = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(active);

    const waiting = acquireSyncLock(
      lockPath,
      { auto: true, fromNotify: true },
      { notifyWaitMs: 200, notifyPollMs: 10 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await active.release();

    const acquired = await waiting;
    assert.ok(acquired);
    await acquired.release();
  });
});

test("notify sync permits only one coalesced lock waiter", async () => {
  await withLockPath(async (lockPath) => {
    const active = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(active);

    const firstWaiter = acquireSyncLock(
      lockPath,
      { auto: true, fromNotify: true },
      { notifyWaitMs: 200, notifyPollMs: 10 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const duplicateWaiter = await acquireSyncLock(
      lockPath,
      { auto: true, fromNotify: true },
      { notifyWaitMs: 200, notifyPollMs: 10 },
    );
    assert.equal(duplicateWaiter, null);

    await active.release();
    const acquired = await firstWaiter;
    assert.ok(acquired);
    await acquired.release();
  });
});

test("notify sync stops waiting at its bounded deadline", async () => {
  await withLockPath(async (lockPath) => {
    const active = await openLock(lockPath, { quietIfLocked: true });
    assert.ok(active);

    const acquired = await acquireSyncLock(
      lockPath,
      { auto: true, fromNotify: true },
      { notifyWaitMs: 30, notifyPollMs: 5 },
    );
    assert.equal(acquired, null);
    await assert.rejects(fs.stat(`${lockPath}.notify-wait`), { code: "ENOENT" });
    await active.release();
  });
});
