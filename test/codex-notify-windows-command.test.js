const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

// Turn-end syncing on native Windows regressed because the Codex/Every Code
// notify command was hardcoded to `/usr/bin/env node ...`, which Windows cannot
// execute — so notify.cjs never launched (issue #361). These tests lock in the
// OS-aware command and assert Windows setup/repair never writes `/usr/bin/env`.

process.env.TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY = "1";
process.env.TOKENTRACKER_SKIP_FIRST_SYNC = "1";
process.env.TOKENTRACKER_SKIP_OPENCLAW_CLI = "1";

const {
  buildCodexNotifyCmd,
  buildEveryCodeNotifyCmd,
} = require("../src/lib/codex-config");
const { repairCodexNotifyIntegration } = require("../src/commands/init");
const { withHome } = require("./helpers/with-home");

test("buildCodexNotifyCmd targets the Node executable on Windows", () => {
  const notifyPath = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
  const cmd = buildCodexNotifyCmd(notifyPath, {
    platform: "win32",
    execPath: "C:\\node\\node.exe",
  });
  assert.deepEqual(cmd, ["C:\\node\\node.exe", notifyPath]);
  assert.ok(!cmd.includes("/usr/bin/env"));
});

test("buildCodexNotifyCmd keeps the /usr/bin/env form on POSIX", () => {
  const notifyPath = "/home/a/.tokentracker/bin/notify.cjs";
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(buildCodexNotifyCmd(notifyPath, { platform }), [
      "/usr/bin/env",
      "node",
      notifyPath,
    ]);
  }
});

test("buildEveryCodeNotifyCmd appends the every-code source on both platforms", () => {
  const notifyPath = "C:\\Users\\a\\.tokentracker\\bin\\notify.cjs";
  assert.deepEqual(
    buildEveryCodeNotifyCmd(notifyPath, { platform: "win32", execPath: "C:\\node\\node.exe" }),
    ["C:\\node\\node.exe", notifyPath, "--source=every-code"],
  );
  const posixPath = "/home/a/.tokentracker/bin/notify.cjs";
  assert.deepEqual(buildEveryCodeNotifyCmd(posixPath, { platform: "linux" }), [
    "/usr/bin/env",
    "node",
    posixPath,
    "--source=every-code",
  ]);
});

test("Windows Codex repair never writes /usr/bin/env to config.toml", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codex-win-"));
  const restoreHome = withHome(dir);
  const prevCodexHome = process.env.CODEX_HOME;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const codexHome = path.join(dir, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const trackerDir = path.join(dir, ".tokentracker");
  const binDir = path.join(trackerDir, "bin");

  try {
    process.env.CODEX_HOME = codexHome;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(codexConfigPath, 'model = "gpt-5-codex"\n', "utf8");

    const result = await repairCodexNotifyIntegration({
      home: dir,
      trackerDir,
      binDir,
      safeMode: false,
    });
    assert.equal(result.changed, true);

    const written = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(!written.includes("/usr/bin/env"), written);
    assert.ok(written.includes("notify = ["), written);
    // The rewritten command launches notify.cjs via the running Node executable.
    assert.ok(written.includes("notify.cjs"), written);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    restoreHome();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
