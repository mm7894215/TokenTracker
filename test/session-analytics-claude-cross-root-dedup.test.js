/**
 * Claude session files must be deduped ACROSS discovery roots.
 *
 * Multi-root discovery (#380) scans a native and a WSL Claude home. Codex
 * already collapses the same session found in both roots via its session-id
 * pass, but Claude only ever had per-file message dedup
 * (`claudeMessageDedupKey` inside `scanClaudeSession`), which cannot see a
 * second copy of the same file under a different path spelling. Every
 * discovered path becomes its own session row keyed by
 * `sessionFileCacheKey(source, path.resolve(filePath))`, so a WSL `$HOME` that
 * points at the Windows profile — the same files reachable as both
 * `C:\Users\dev\.claude\...` and `\\wsl$\Ubuntu\home\dev\.claude\...` —
 * produced duplicate rows in the session browser, its project list and the
 * CSV export.
 *
 * Dedup is deliberately CROSS-root only: two files inside one root are never
 * treated as copies of each other, so single-root installs (macOS, Linux,
 * native-only Windows) are bit-for-bit unaffected.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { dedupeClaudeFilesAcrossRoots } = require("../src/lib/session-analytics");

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-roots-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One session file per root, same basename UUID -> the same session reachable
// under two path spellings.
function seedRoot(base, name, uuid, mtimeMs) {
  const dir = path.join(base, name, "projects", "-Users-dev-app");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(filePath, "{}\n");
  if (mtimeMs) fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("the same session found in two roots collapses to one file", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 2_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.equal(deduped.length, 1, "one session must not yield two rows");
    // Newest wins, matching the Codex session-id pass.
    assert.equal(deduped[0], wsl);
  });
});

test("the older copy wins when it is the newer file in the other root", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 5_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 1_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.deepEqual(deduped, [native]);
  });
});

test("distinct sessions in different roots are both kept", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_B, 1_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.equal(deduped.length, 2);
    assert.ok(deduped.includes(native) && deduped.includes(wsl));
  });
});

test("a single root is returned untouched, including same-UUID siblings", () => {
  withTmp((tmp) => {
    // Two projects can legitimately hold files with the same basename in one
    // tree (a copied transcript, a restored backup). Within one root nothing is
    // dropped -- only cross-root duplicates are copies by construction.
    const dir = path.join(tmp, "native", "projects");
    const first = path.join(dir, "-Users-dev-a", `${UUID_A}.jsonl`);
    const second = path.join(dir, "-Users-dev-b", `${UUID_A}.jsonl`);
    for (const p of [first, second]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{}\n");
    }

    const deduped = dedupeClaudeFilesAcrossRoots([[first, second]]);
    assert.deepEqual(deduped, [first, second]);
  });
});

test("files without a UUID basename are never deduped", () => {
  withTmp((tmp) => {
    const dirA = path.join(tmp, "native", "projects", "-Users-dev-a");
    const dirB = path.join(tmp, "wsl", "projects", "-Users-dev-a");
    const a = path.join(dirA, "notes.jsonl");
    const b = path.join(dirB, "notes.jsonl");
    for (const p of [a, b]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{}\n");
    }

    // Unproven identity must not delete a session.
    const deduped = dedupeClaudeFilesAcrossRoots([[a], [b]]);
    assert.equal(deduped.length, 2);
  });
});

test("ordering follows the root order so native precedence is stable", () => {
  withTmp((tmp) => {
    const nativeA = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wslB = seedRoot(tmp, "wsl", UUID_B, 1_000_000);

    assert.deepEqual(dedupeClaudeFilesAcrossRoots([[nativeA], [wslB]]), [nativeA, wslB]);
  });
});
