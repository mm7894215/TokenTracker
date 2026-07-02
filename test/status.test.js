const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { test } = require("node:test");

const { cmdStatus } = require("../src/commands/status");
const { mockPlatform, mockMethod } = require("./helpers/mock");

test("status prints last upload timestamps from upload.throttle.json", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = [\"/usr/bin/env\", \"node\", \"~/.tokentracker/bin/notify.cjs\"]\n',
      "utf8",
    );

    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify(
        { baseUrl: "https://example.invalid", deviceToken: "t", deviceId: "d" },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "cursors.json"),
      JSON.stringify({ updatedAt: "2025-12-18T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(trackerDir, "queue.jsonl"), "", "utf8");
    await fs.writeFile(
      path.join(trackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0 }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "openclaw.signal"),
      "2026-02-12T00:00:00.000Z\n",
      "utf8",
    );

    const lastSuccessMs = 1766053145522; // 2025-12-18T10:19:05.522Z
    const nextAllowedAtMs = lastSuccessMs + 1000;
    await fs.writeFile(
      path.join(trackerDir, "upload.throttle.json"),
      JSON.stringify(
        { version: 1, lastSuccessMs, nextAllowedAtMs, backoffUntilMs: 0, backoffStep: 0 },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.match(out, /- Base URL: https:\/\/example\.invalid/);
    assert.match(out, /- Last upload: 2025-12-18T10:19:05\.522Z/);
    assert.match(out, /- Last OpenClaw-triggered sync: 2026-02-12T00:00:00.000Z/);
    assert.match(out, /- Next upload after: 2025-12-18T10:19:06\.522Z/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status native-only mode does not probe WSL distros", async (t) => {
  mockPlatform(t, "win32");
  let wslCalls = 0;
  mockMethod(t, cp, "execFileSync", (cmd) => {
    if (cmd === "wsl.exe") wslCalls++;
    throw new Error("unexpected child process call");
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-wsl-mode-"));
  const prevEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE,
  };
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
    process.env.APPDATA = path.join(tmp, "AppData", "Roaming");
    process.env.TOKENTRACKER_WSL_MODE = "native-only";

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.equal(wslCalls, 0);
    assert.match(out, /- WSL mode: native-only/);
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.stdout.write = prevWrite;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status does not migrate legacy tracker directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-legacy-"));
  const prevHome = process.env.HOME;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");

    const legacyTrackerDir = path.join(tmp, ".legacy-tracker-root", "tracker");
    await fs.mkdir(legacyTrackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = [\"/usr/bin/env\", \"node\", \"~/.legacy-tracker-root/bin/notify.cjs\"]\n',
      "utf8",
    );

    await fs.writeFile(
      path.join(legacyTrackerDir, "config.json"),
      JSON.stringify(
        { baseUrl: "https://example.invalid", deviceToken: "t", deviceId: "d" },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyTrackerDir, "cursors.json"),
      JSON.stringify({ updatedAt: "2025-12-18T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(legacyTrackerDir, "queue.jsonl"), "", "utf8");
    await fs.writeFile(
      path.join(legacyTrackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0 }) + "\n",
      "utf8",
    );

    const lastSuccessMs = 1766053145522; // 2025-12-18T10:19:05.522Z
    const nextAllowedAtMs = lastSuccessMs + 1000;
    await fs.writeFile(
      path.join(legacyTrackerDir, "upload.throttle.json"),
      JSON.stringify(
        { version: 1, lastSuccessMs, nextAllowedAtMs, backoffUntilMs: 0, backoffStep: 0 },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.match(out, /- Base URL: unset/);
    assert.match(out, /- Last upload: never/);
    const newTrackerDir = path.join(tmp, ".tokentracker", "tracker");
    await assert.rejects(fs.stat(newTrackerDir));
    await fs.stat(legacyTrackerDir);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
