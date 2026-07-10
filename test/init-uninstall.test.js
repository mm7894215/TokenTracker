const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  cmdInit,
  buildNotifyHandler,
  repairCodexNotifyIntegration,
} = require("../src/commands/init");
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

async function runGeneratedNotifyHandler({ trackerDir, notify, args = ["--source=codex", "turn-ended"] }) {
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
      [notifyPath, ...args],
      { env },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end();
  });
}

test("notify handler chains executable original notify commands and skips stale explicit paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
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
    assert.equal(await waitForFile(markerPath, { timeoutMs: 5000 }), "ran");

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-missing"),
      notify: [path.join(tmp, "missing-notify"), "turn-ended"],
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips an original notify that nests itself", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const notifyPath = path.join(await fs.realpath(trackerDir), "notify.cjs");
    const markerPath = path.join(tmp, "sky-marker");
    const skyPath = path.join(tmp, "SkyComputerUseClient");
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir,
      notify: [
        skyPath,
        "turn-ended",
        "--previous-notify",
        JSON.stringify(["/usr/bin/env", "node", notifyPath]),
      ],
    });

    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler avoids duplicating existing payload args when chaining", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "dedupe-marker");
    const shimPath = path.join(tmp, "dedupe-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-dedupe"),
      notify: [process.execPath, shimPath, "turn-ended"],
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.equal(marker, "turn-ended");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler preserves legitimate repeated payload args when chaining", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "repeat-marker");
    const shimPath = path.join(tmp, "repeat-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-repeat"),
      notify: [process.execPath, shimPath, "turn-ended"],
      args: ["--source=codex", "--include", "a", "--include", "b"],
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.equal(marker, "turn-ended|--include|a|--include|b");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair installs TokenTracker and preserves Sky original", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
    ];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(skyNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    await fs.stat(path.join(binDir, "notify.cjs"));
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /notify\.cjs/);
    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, skyNotify);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair leaves Sky wrapping TokenTracker unchanged", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    const notifyPath = path.join(binDir, "notify.cjs");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const tokenTrackerNotify = ["/usr/bin/env", "node", notifyPath];
    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
      "--previous-notify",
      JSON.stringify(tokenTrackerNotify),
    ];
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, `notify = ${JSON.stringify(skyNotify)}\n`, "utf8");

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "already-wrapped");
    assert.deepEqual(await fs.readFile(codexConfigPath, "utf8"), `notify = ${JSON.stringify(skyNotify)}\n`);
    await assert.rejects(
      fs.stat(path.join(trackerDir, "codex_notify_original.json")),
      /ENOENT/,
    );
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair refreshes stale backup when active notify is Sky", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });

    const staleNotify = ["old-notify", "arg"];
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
    ];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(skyNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, skyNotify);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair clears stale backup when active notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;
  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });

    const staleNotify = ["old-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "model = \"gpt-5\"\n", "utf8");

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    process.stdout.write = () => true;
    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-notify/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair skips unknown third-party notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = ["third-party-notify", "arg"]\n',
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "external-notify");
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /third-party-notify/);
    assert.doesNotMatch(config, /notify\.cjs/);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair skips unknown notify.cjs command", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    const externalNotify = ["/usr/bin/env", "node", path.join(tmp, "custom", "notify.cjs")];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(externalNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "external-notify");
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /custom/);
    assert.doesNotMatch(config, /\.tokentracker/);
    await assert.rejects(
      fs.stat(path.join(trackerDir, "codex_notify_original.json")),
      /ENOENT/,
    );
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler still chains normal original notify commands", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
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

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.ok(marker, "expected chained notify marker to be written");
    assert.ok(marker.includes("turn-ended"), "expected payload args to be forwarded");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init preserves existing config fields and custom URLs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-config-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify(
        {
          installedAt: "2026-04-01T00:00:00.000Z",
          baseUrl: "https://self-hosted.example",
          dashboardUrl: "https://dashboard.example",
          deviceToken: "device-token",
          deviceId: "device-id",
          customFlag: true,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open"]);

    const config = JSON.parse(await fs.readFile(path.join(trackerDir, "config.json"), "utf8"));
    assert.equal(config.installedAt, "2026-04-01T00:00:00.000Z");
    assert.equal(config.baseUrl, "https://self-hosted.example");
    assert.equal(config.dashboardUrl, "https://dashboard.example");
    assert.equal(config.deviceToken, "device-token");
    assert.equal(config.deviceId, "device-id");
    assert.equal(config.customFlag, true);
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

test("init then uninstall restores original Codex notify (when pre-existing notify exists)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

test("init refreshes stale Codex backup when current notify is external", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-refresh-backup-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-notify", "arg"];
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const externalNotify = ["third-party-notify", "new"];
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, `notify = ${JSON.stringify(externalNotify)}\n`, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, externalNotify);

    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /third-party-notify/);
    assert.doesNotMatch(restored, /old-notify/);
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

test("init clears stale Codex backup when current notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-clear-backup-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "model = \"gpt-5\"\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-notify/);
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

test("uninstall does not restore stale backup over active third-party Codex notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, 'notify = ["third-party-notify", "new"]\n', "utf8");
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: ["old-notify"], capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );

    process.stdout.write = () => true;
    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.equal(restored, 'notify = ["third-party-notify", "new"]\n');
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

test("init clears stale Every Code backup when current notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-code-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codeConfigPath, "model = \"gpt-5\"\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    await cmdUninstall([]);
    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-code-notify/);
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

test("init refreshes stale Every Code backup when current notify is external", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-code-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const externalNotify = ["third-party-code-notify", "new"];
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codeConfigPath, `notify = ${JSON.stringify(externalNotify)}\n`, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.deepEqual(original.notify, externalNotify);

    await cmdUninstall([]);
    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.match(restored, /third-party-code-notify/);
    assert.doesNotMatch(restored, /old-code-notify/);
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-grok-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
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
