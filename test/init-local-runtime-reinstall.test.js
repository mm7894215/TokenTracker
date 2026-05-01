const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { installLocalTrackerApp } = require("../src/commands/init");

const repoRoot = path.join(__dirname, "..");

function runTracker(args, env) {
  return spawnSync(process.execPath, [path.join(repoRoot, "bin", "tracker.js"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function runLocalTracker(trackerBinPath, args, env) {
  return spawnSync(process.execPath, [trackerBinPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("init can rerun from installed local runtime without self-deleting app source", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-local-runtime-"));
  const env = {
    ...process.env,
    HOME: tmp,
    CODEX_HOME: path.join(tmp, ".codex"),
    OPENCODE_CONFIG_DIR: path.join(tmp, ".config", "opencode"),
  };
  delete env.TOKENTRACKER_DEVICE_TOKEN;

  try {
    await fs.mkdir(env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(env.CODEX_HOME, "config.toml"), "# empty\n", "utf8");

    const firstInit = runTracker(
      ["init", "--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"],
      env,
    );
    assert.equal(
      firstInit.status,
      0,
      `expected first init to succeed\nstdout:\n${firstInit.stdout}\nstderr:\n${firstInit.stderr}`,
    );

    const trackerBinPath = path.join(tmp, ".tokentracker", "tracker", "app", "bin", "tracker.js");
    await fs.stat(trackerBinPath);

    const secondInit = runLocalTracker(
      trackerBinPath,
      ["init", "--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"],
      env,
    );
    assert.equal(
      secondInit.status,
      0,
      `expected local runtime init to succeed\nstdout:\n${secondInit.stdout}\nstderr:\n${secondInit.stderr}`,
    );

    await fs.stat(path.join(tmp, ".tokentracker", "tracker", "app", "src", "commands", "init.js"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("installLocalTrackerApp replaces stale installed runtime and writes a package marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-runtime-refresh-"));
  try {
    const appDir = path.join(tmp, "app");
    await fs.mkdir(path.join(appDir, "src", "lib"), { recursive: true });
    await fs.mkdir(path.join(appDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(appDir, "src", "lib", "cursor-config.js"), "stale parser\n", "utf8");
    await fs.writeFile(path.join(appDir, "bin", "tracker.js"), "stale bin\n", "utf8");

    await installLocalTrackerApp({ appDir });

    const copiedParser = await fs.readFile(path.join(appDir, "src", "lib", "cursor-config.js"), "utf8");
    const marker = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
    assert.notEqual(copiedParser, "stale parser\n");
    assert.equal(marker.name, "tokentracker-cli");
    assert.equal(typeof marker.version, "string");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
