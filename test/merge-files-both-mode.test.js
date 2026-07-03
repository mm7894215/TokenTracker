const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { mockPlatform } = require("./helpers/mock");

const wslProbe = require("../src/lib/wsl-probe");
const { mergeBothFileSources } = require("../src/lib/multi-install-parser");

function makeProviderDirs(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tt-merge-${prefix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, "native");
  const wslDir = path.join(root, "wsl");
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(wslDir, { recursive: true });
  return { root, native, wsl: wslDir };
}

function resolveForInstall(env, nativeDir, wslDir) {
  const dir = wslProbe.getWslMode(env) === "wsl-only" ? wslDir : nativeDir;
  return fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, f));
}

describe("mergeBothFileSources in both mode", { concurrency: 1 }, () => {

  test("discovers files from both installs", (t) => {
    mockPlatform(t, "win32");
    const { native, wsl } = makeProviderDirs(t, "disc");
    fs.writeFileSync(path.join(native, "session-1.wire.jsonl"), "{}");
    fs.writeFileSync(path.join(native, "session-2.wire.jsonl"), "{}");
    fs.writeFileSync(path.join(wsl, "session-3.wire.jsonl"), "{}");

    const files = mergeBothFileSources({
      resolveFiles: (env) => resolveForInstall(env, native, wsl),
      env: { TOKENTRACKER_WSL_MODE: "both" },
    });

    assert.equal(files.length, 3, "should find 3 total files from both installs");
    const names = files.map(f => path.basename(f)).sort();
    assert.deepEqual(names, ["session-1.wire.jsonl", "session-2.wire.jsonl", "session-3.wire.jsonl"]);
  });

  test("deduplicates identical file paths", (t) => {
    mockPlatform(t, "win32");
    const { native } = makeProviderDirs(t, "dedup");
    const shared = path.join(native, "shared.jsonl");
    fs.writeFileSync(shared, "{}");

    const files = mergeBothFileSources({
      resolveFiles: () => [shared, shared],
      env: { TOKENTRACKER_WSL_MODE: "both" },
    });

    assert.equal(files.length, 1, "duplicate paths should be deduplicated");
  });

  test("returns single-install files when not in both mode", (t) => {
    mockPlatform(t, "win32");
    const { native, wsl } = makeProviderDirs(t, "single");
    fs.writeFileSync(path.join(native, "a.jsonl"), "{}");
    fs.writeFileSync(path.join(wsl, "b.jsonl"), "{}");

    const files = mergeBothFileSources({
      resolveFiles: (env) => resolveForInstall(env, native, wsl),
      env: { TOKENTRACKER_WSL_MODE: "wsl-first" },
    });

    assert.equal(files.length, 1, "only native-install files in wsl-first mode");
  });
});
