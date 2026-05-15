const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdInit, buildNotifyHandler } = require("../src/commands/init");
const { cmdUninstall } = require("../src/commands/uninstall");
const { buildClaudeHookCommand } = require("../src/lib/claude-config");
const { buildGeminiHookCommand } = require("../src/lib/gemini-config");
const {
  buildOpencodePlugin,
  DEFAULT_EVENT,
  DEFAULT_PLUGIN_NAME,
  PLUGIN_MARKER,
} = require("../src/lib/opencode-config");
const { GROK_HOOK_FILENAME } = require("../src/lib/grok-hook");

async function waitForFile(filePath, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function flattenHookEntries(entries) {
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]));
}

async function runGeneratedNotifyHandler({ trackerDir, notify }) {
  await fs.mkdir(trackerDir, { recursive: true });
  const notifyPath = path.join(trackerDir, "notify.cjs");
  await fs.writeFile(
    notifyPath,
    buildNotifyHandler({ trackerDir, packageName: "tokentracker-cli" }),
    "utf8",
  );
  await fs.chmod(notifyPath, 0o755);
  await fs.writeFile(
    path.join(trackerDir, "codex_notify_original.json"),
    JSON.stringify({ notify, capturedAt: new Date().toISOString() }),
    "utf8",
  );
  await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TOKENTRACKER_DEVICE_TOKEN;
    const child = require("node:child_process").execFile(
      process.execPath,
      [notifyPath, "--source=codex", "turn-ended"],
      { env },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end();
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test("notify handler skips SkyComputerUseClient and stale explicit original notify paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "unsafe-marker");
    const skyDir = path.join(
      tmp,
      ".codex",
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.750",
      "Codex Computer Use.app",
      "Contents",
      "SharedSupport",
      "SkyComputerUseClient.app",
      "Contents",
      "MacOS",
    );
    const skyPath = path.join(skyDir, "SkyComputerUseClient");
    await fs.mkdir(skyDir, { recursive: true });
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-sky"),
      notify: [skyPath, "turn-ended"],
    });
    await assert.rejects(fs.stat(markerPath), /ENOENT/);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-missing"),
      notify: [path.join(tmp, "missing-notify"), "turn-ended"],
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler still chains normal original notify commands", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "safe-marker");
    const shimPath = path.join(tmp, "safe-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-safe"),
      notify: [process.execPath, shimPath],
    });

    const marker = await fs.readFile(markerPath, "utf8");
    assert.ok(marker.includes("turn-ended"), "expected payload args to be forwarded");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall restores original Codex notify (when pre-existing notify exists)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex-alt");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    const originalNotify = 'notify = ["echo", "hello"]\n';
    await fs.writeFile(codexConfigPath, originalNotify, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codexConfigPath, "utf8");
    assert.match(installed, /^notify\s*=\s*\[.+\]\s*$/m);
    assert.ok(!installed.includes('["echo", "hello"]'), "expected init to override notify");

    const cursorsPath = path.join(tmp, ".tokentracker", "tracker", "cursors.json");
    const cursorsRaw = await waitForFile(cursorsPath);
    assert.ok(cursorsRaw, "expected init to trigger sync and write cursors");
    const cursors = JSON.parse(cursorsRaw);
    assert.ok(typeof cursors.updatedAt === "string" && cursors.updatedAt.length > 0);

    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(
      restored.includes('notify = ["echo", "hello"]'),
      "expected uninstall to restore original notify",
    );

    const notifyHandlerPath = path.join(tmp, ".tokentracker", "bin", "notify.cjs");
    await assert.rejects(fs.stat(notifyHandlerPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("opencode plugin uses session.updated event", () => {
  const plugin = buildOpencodePlugin({ notifyPath: "/tmp/notify.cjs" });
  assert.match(plugin, /session\.updated/);
});

test("opencode config exports plugin constants", () => {
  assert.equal(typeof PLUGIN_MARKER, "string");
  assert.ok(PLUGIN_MARKER.length > 0);
  assert.equal(DEFAULT_EVENT, "session.updated");
  assert.equal(DEFAULT_PLUGIN_NAME, "tokentracker.js");
});

test("init then uninstall removes notify when none existed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codexConfigPath, "utf8");
    assert.match(installed, /^notify\s*=\s*\[.+\]\s*$/m);

    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(
      !/^notify\s*=.*$/m.test(restored),
      "expected uninstall to remove notify when none existed",
    );
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Codex notify when config is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await assert.rejects(fs.stat(codexConfigPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall restores original Every Code notify (when config exists)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    const originalNotify = 'notify = ["echo", "hello-code"]\n';
    await fs.writeFile(codeConfigPath, originalNotify, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codeConfigPath, "utf8");
    assert.match(installed, /notify\s*=\s*\[[^\n]*notify\.cjs[^\n]*--source=every-code[^\n]*\]/);
    assert.ok(
      !installed.includes('["echo", "hello-code"]'),
      "expected init to override Every Code notify",
    );

    await cmdUninstall([]);

    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.ok(
      restored.includes('notify = ["echo", "hello-code"]'),
      "expected uninstall to restore Every Code notify",
    );
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Every Code notify when config is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await assert.rejects(fs.stat(codeConfigPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstall skips notify restore when no backup and notify not installed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, 'notify = ["echo", "custom-codex"]\n', "utf8");
    await fs.writeFile(codeConfigPath, 'notify = ["echo", "custom-code"]\n', "utf8");

    process.stdout.write = () => true;
    await cmdUninstall([]);

    const codexAfter = await fs.readFile(codexConfigPath, "utf8");
    const codeAfter = await fs.readFile(codeConfigPath, "utf8");
    assert.ok(codexAfter.includes('notify = ["echo", "custom-codex"]'));
    assert.ok(codeAfter.includes('notify = ["echo", "custom-code"]'));
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstall removes Grok Build hook and handler", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-grok-uninstall-"));
  const prevHome = process.env.HOME;
  const prevGrokHome = process.env.GROK_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.GROK_HOME = path.join(tmp, ".grok");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const hookPath = path.join(process.env.GROK_HOME, "hooks", GROK_HOOK_FILENAME);
    const handlerPath = path.join(tmp, ".tokentracker", "bin", "grok-session-end-hook.cjs");
    const legacyHandlerPath = path.join(trackerDir, "bin", "grok-session-end-hook.cjs");

    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.mkdir(path.dirname(handlerPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyHandlerPath), { recursive: true });
    await fs.writeFile(
      hookPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `/usr/bin/env node ${handlerPath}` }] },
          ],
        },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(handlerPath, "handler\n", "utf8");
    await fs.writeFile(legacyHandlerPath, "legacy handler\n", "utf8");

    process.stdout.write = () => true;
    await cmdUninstall([]);

    await assert.rejects(fs.stat(hookPath), /ENOENT/);
    await assert.rejects(fs.stat(handlerPath), /ENOENT/);
    await assert.rejects(fs.stat(legacyHandlerPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Claude hooks without removing existing hooks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const claudeDir = path.join(tmp, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const existingCommand = "echo existing-claude";
    const settings = {
      env: { SAMPLE: "1" },
      hooks: {
        SessionEnd: [
          {
            hooks: [{ command: existingCommand }],
          },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installedRaw = await fs.readFile(settingsPath, "utf8");
    const installed = JSON.parse(installedRaw);
    const hookCommand = buildClaudeHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const sessionEnd = installed?.hooks?.SessionEnd || [];
    const allCommands = sessionEnd
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(allCommands.includes(existingCommand), "expected existing Claude hook to remain");
    assert.ok(allCommands.includes(hookCommand), "expected tracker Claude hook to be added");

    await cmdUninstall([]);

    const restoredRaw = await fs.readFile(settingsPath, "utf8");
    const restored = JSON.parse(restoredRaw);
    const restoredSessionEnd = restored?.hooks?.SessionEnd || [];
    const restoredCommands = restoredSessionEnd
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(
      restoredCommands.includes(existingCommand),
      "expected existing Claude hook to remain",
    );
    assert.ok(
      !restoredCommands.includes(hookCommand),
      "expected tracker Claude hook to be removed",
    );
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Gemini hooks without removing existing hooks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.GEMINI_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const settingsPath = path.join(process.env.GEMINI_HOME, "settings.json");
    const existingCommand = "echo existing-gemini";
    const settings = {
      tools: { enableHooks: false },
      hooks: {
        disabled: ["existing-disabled"],
        SessionEnd: [
          {
            matcher: "exit",
            hooks: [{ name: "existing-gemini", type: "command", command: existingCommand }],
          },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installedRaw = await fs.readFile(settingsPath, "utf8");
    const installed = JSON.parse(installedRaw);
    assert.equal(installed?.tools?.enableHooks, true);
    assert.deepEqual(installed?.hooks?.disabled, ["existing-disabled"]);
    const hookCommand = buildGeminiHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const sessionEnd = installed?.hooks?.SessionEnd || [];
    const hooks = flattenHookEntries(sessionEnd);
    const allCommands = hooks.map((h) => h?.command);
    const trackerEntry = sessionEnd.find(
      (entry) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === hookCommand),
    );
    assert.ok(allCommands.includes(existingCommand), "expected existing Gemini hook to remain");
    assert.ok(allCommands.includes(hookCommand), "expected tracker Gemini hook to be added");
    assert.equal(trackerEntry?.matcher, "exit|clear|logout|prompt_input_exit|other");

    await cmdUninstall([]);

    const restoredRaw = await fs.readFile(settingsPath, "utf8");
    const restored = JSON.parse(restoredRaw);
    assert.equal(restored?.tools?.enableHooks, true);
    assert.deepEqual(restored?.hooks?.disabled, ["existing-disabled"]);
    const restoredSessionEnd = restored?.hooks?.SessionEnd || [];
    const restoredHooks = flattenHookEntries(restoredSessionEnd);
    const restoredCommands = restoredHooks.map((h) => h?.command);
    assert.ok(
      restoredCommands.includes(existingCommand),
      "expected existing Gemini hook to remain",
    );
    assert.ok(
      !restoredCommands.includes(hookCommand),
      "expected tracker Gemini hook to be removed",
    );
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Gemini hooks when config directory is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini-missing");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    await assert.rejects(fs.stat(process.env.GEMINI_HOME), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init creates Gemini settings when directory exists but file is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.GEMINI_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const settingsPath = path.join(process.env.GEMINI_HOME, "settings.json");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const createdRaw = await fs.readFile(settingsPath, "utf8");
    const created = JSON.parse(createdRaw);
    assert.equal(created?.tools?.enableHooks, true);
    const sessionEnd = created?.hooks?.SessionEnd || [];
    const hooks = flattenHookEntries(sessionEnd);
    const hookCommand = buildGeminiHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const hasTracker = hooks.some((hook) => hook?.command === hookCommand);
    assert.ok(hasTracker, "expected tracker Gemini hook to be created in settings.json");
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Opencode plugin without removing other plugins", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const opencodeDir = path.join(tmp, ".config", "opencode");
    const pluginDir = path.join(opencodeDir, "plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    const existingPluginPath = path.join(pluginDir, "existing.js");
    await fs.writeFile(existingPluginPath, "// existing\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const pluginPath = path.join(pluginDir, "tokentracker.js");
    const installed = await fs.readFile(pluginPath, "utf8");
    assert.match(installed, /TOKENTRACKER_PLUGIN/);

    await cmdUninstall([]);

    await assert.rejects(fs.stat(pluginPath), /ENOENT/);
    const existing = await fs.readFile(existingPluginPath, "utf8");
    assert.ok(existing.includes("existing"));
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init installs Opencode plugin when config dir is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vibeusage-init-uninstall-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const pluginPath = path.join(process.env.OPENCODE_CONFIG_DIR, "plugin", "tokentracker.js");
    const installed = await fs.readFile(pluginPath, "utf8");
    assert.match(installed, /TOKENTRACKER_PLUGIN/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
