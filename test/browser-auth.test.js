const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  openInBrowser,
  resolveBrowserLaunchCommand,
} = require("../src/lib/browser-auth");

test("resolveBrowserLaunchCommand prefers wslview in WSL without a graphical session", () => {
  const launch = resolveBrowserLaunchCommand("http://127.0.0.1:7680", {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    commandExists(command) {
      return command === "wslview";
    },
  });

  assert.deepEqual(launch, {
    command: "wslview",
    args: ["http://127.0.0.1:7680"],
  });
});

test("resolveBrowserLaunchCommand returns null for headless Linux without wslview", () => {
  const launch = resolveBrowserLaunchCommand("http://127.0.0.1:7680", {
    platform: "linux",
    env: {},
    commandExists() {
      return false;
    },
  });

  assert.equal(launch, null);
});

test("resolveBrowserLaunchCommand uses powershell on Windows and escapes single quotes", () => {
  const launch = resolveBrowserLaunchCommand("https://example.com/?q=it's&x=1", {
    platform: "win32",
  });

  assert.deepEqual(launch, {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Start-Process -FilePath 'https://example.com/?q=it''s&x=1'",
    ],
  });
});

test("resolveBrowserLaunchCommand prefers xdg-open on Linux desktops", () => {
  const launch = resolveBrowserLaunchCommand("http://127.0.0.1:7680", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    commandExists(command) {
      return command === "xdg-open" || command === "gio";
    },
  });

  assert.deepEqual(launch, {
    command: "xdg-open",
    args: ["http://127.0.0.1:7680"],
  });
});

test("resolveBrowserLaunchCommand falls back to gio when xdg-open is unavailable", () => {
  const launch = resolveBrowserLaunchCommand("http://127.0.0.1:7680", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    commandExists(command) {
      return command === "gio";
    },
  });

  assert.deepEqual(launch, {
    command: "gio",
    args: ["open", "http://127.0.0.1:7680"],
  });
});

test("openInBrowser does not spawn a child when no browser launcher is available", () => {
  const calls = [];
  const opened = openInBrowser("http://127.0.0.1:7680", {
    platform: "linux",
    env: {},
    commandExists() {
      return false;
    },
    spawn() {
      calls.push("spawn");
      return { unref() {} };
    },
  });

  assert.equal(opened, false);
  assert.deepEqual(calls, []);
});

test("openInBrowser spawns the resolved Linux launcher detached", () => {
  const calls = [];
  const opened = openInBrowser("http://127.0.0.1:7680", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    commandExists(command) {
      return command === "gio";
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {
        unref() {
          calls.push({ unref: true });
        },
      };
    },
  });

  assert.equal(opened, true);
  assert.deepEqual(calls[0], {
    command: "gio",
    args: ["open", "http://127.0.0.1:7680"],
    options: { stdio: "ignore", detached: true },
  });
  assert.deepEqual(calls[1], { unref: true });
});

test("openInBrowser falls back to open on macOS when osascript is unavailable", () => {
  const calls = [];
  const opened = openInBrowser("http://127.0.0.1:7680", {
    platform: "darwin",
    env: {},
    commandExists(command) {
      return command === "open";
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {
        unref() {
          calls.push({ unref: true });
        },
      };
    },
  });

  assert.equal(opened, true);
  assert.deepEqual(calls[0], {
    command: "open",
    args: ["http://127.0.0.1:7680"],
    options: { stdio: "ignore", detached: true },
  });
  assert.deepEqual(calls[1], { unref: true });
});
