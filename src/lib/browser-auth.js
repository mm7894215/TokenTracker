const http = require("node:http");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_BASE_URL } = require("./runtime-config");

async function beginBrowserAuth({ baseUrl, dashboardUrl, timeoutMs, open }) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const callbackPath = `/tokentracker/callback/${nonce}`;
  const authUrl = dashboardUrl ? new URL("/", dashboardUrl) : new URL("/auth/sign-up", baseUrl);
  const postAuthRedirect = resolvePostAuthRedirect({ dashboardUrl, authUrl });
  const { callbackUrl, waitForCallback } = await startLocalCallbackServer({
    callbackPath,
    timeoutMs,
    redirectUrl: postAuthRedirect,
  });
  authUrl.searchParams.set("redirect", callbackUrl);
  if (dashboardUrl && baseUrl && baseUrl !== DEFAULT_BASE_URL) {
    authUrl.searchParams.set("base_url", baseUrl);
  }

  if (open !== false) openInBrowser(authUrl.toString());

  return { authUrl: authUrl.toString(), waitForCallback };
}

async function startLocalCallbackServer({ callbackPath, timeoutMs, redirectUrl }) {
  let resolved = false;
  let resolveResult;
  let rejectResult;

  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((req, res) => {
    if (resolved) {
      res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Already authenticated.\n");
      return;
    }

    const method = req.method || "GET";
    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed.\n");
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found.\n");
      return;
    }

    const accessToken = url.searchParams.get("access_token") || "";
    if (!accessToken) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing access_token.\n");
      return;
    }

    resolved = true;
    if (redirectUrl) {
      res.writeHead(302, {
        Location: redirectUrl,
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(
        [
          "<!doctype html>",
          '<html><head><meta charset="utf-8"><title>TokenTracker</title></head>',
          "<body>",
          "<h2>Login succeeded</h2>",
          `<p>Redirecting to <a href="${redirectUrl}">dashboard</a>...</p>`,
          "</body></html>",
        ].join(""),
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        [
          "<!doctype html>",
          '<html><head><meta charset="utf-8"><title>TokenTracker</title></head>',
          "<body>",
          "<h2>Login succeeded</h2>",
          "<p>You can close this tab and return to the CLI.</p>",
          "</body></html>",
        ].join(""),
      );
    }

    resolveResult({
      accessToken,
      userId: url.searchParams.get("user_id") || null,
      email: url.searchParams.get("email") || null,
      name: url.searchParams.get("name") || null,
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : null;
  if (!port) {
    server.close();
    throw new Error("Failed to bind local callback server");
  }

  const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`;

  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    rejectResult(new Error("Authentication timed out"));
    server.close();
  }, timeoutMs);

  async function waitForCallback() {
    try {
      return await resultPromise;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }

  return { callbackUrl, waitForCallback };
}

function detectDefaultBrowser() {
  try {
    const raw = cp.execFileSync("defaults", [
      "read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers",
    ], { encoding: "utf8", timeout: 3000 });
    const match = raw.match(/https[\s\S]*?LSHandlerRoleAll\s*=\s*"([^"]+)"/);
    if (!match) return null;
    const bundleId = match[1].toLowerCase();
    if (bundleId.includes("chrome")) return "Google Chrome";
    if (bundleId.includes("safari")) return "Safari";
    if (bundleId.includes("edgemac")) return "Microsoft Edge";
    if (bundleId.includes("thebrowser") || bundleId.includes("arc")) return "Arc";
    return null;
  } catch (_e) {
    return null;
  }
}

function buildBrowserList() {
  const all = ["Google Chrome", "Safari", "Microsoft Edge", "Arc"];
  const def = detectDefaultBrowser();
  if (!def) return all;
  return [def, ...all.filter((b) => b !== def)];
}

function isWslSession(env = process.env) {
  return Boolean(
    (typeof env.WSL_DISTRO_NAME === "string" && env.WSL_DISTRO_NAME.trim()) ||
    (typeof env.WSL_INTEROP === "string" && env.WSL_INTEROP.trim()),
  );
}

function hasGraphicalSession(env = process.env) {
  return Boolean(
    (typeof env.DISPLAY === "string" && env.DISPLAY.trim()) ||
    (typeof env.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.trim()),
  );
}

function isCommandAvailable(command, { env = process.env, platform = process.platform } = {}) {
  if (typeof command !== "string" || !command.trim()) return false;

  const pathEntries = String(env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const suffixes = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((ext) => ext.trim())
      .filter(Boolean)
    : [""];

  const candidates = [];
  if (hasPathSeparator) {
    candidates.push(command);
  } else {
    for (const dir of pathEntries) {
      if (platform === "win32") {
        candidates.push(path.join(dir, command));
        for (const ext of suffixes) {
          candidates.push(path.join(dir, `${command}${ext}`));
        }
      } else {
        candidates.push(path.join(dir, command));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_e) {}
  }
  return false;
}

function resolveBrowserLaunchCommand(
  url,
  {
    platform = process.platform,
    env = process.env,
    commandExists = isCommandAvailable,
  } = {},
) {
  if (platform === "win32") {
    const escapedUrl = String(url).replace(/'/g, "''");
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath '${escapedUrl}'`,
      ],
    };
  }

  if (isWslSession(env) && commandExists("wslview", { env, platform })) {
    return { command: "wslview", args: [url] };
  }

  if (!hasGraphicalSession(env)) return null;

  const candidates = [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
    { command: "sensible-browser", args: [url] },
  ];
  for (const candidate of candidates) {
    if (commandExists(candidate.command, { env, platform })) {
      return candidate;
    }
  }
  return null;
}

function openInBrowser(url, { platform = process.platform, env = process.env, spawn = cp.spawn, commandExists = isCommandAvailable } = {}) {

  if (platform === "darwin") {
    // On macOS, prefer reusing a matching tab in a supported running browser.
    // Supported browsers are checked with the user's default browser first.
    const browsers = buildBrowserList();
    const listLiteral = browsers.map((b) => `"${b}"`).join(", ");
    const script = `
tell application "System Events"
  set browserList to {${listLiteral}}
  set runningBrowser to ""
  repeat with b in browserList
    if (exists process (b as text)) then
      set runningBrowser to (b as text)
      exit repeat
    end if
  end repeat
end tell

if runningBrowser is "" then
  open location "${url}"
else if runningBrowser is "Google Chrome" then
  tell application "Google Chrome"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        if URL of t starts with "${url}" then
          set active tab index of w to tabIndex
          set index of w to 1
          reload t
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      open location "${url}"
      activate
    end if
  end tell
else if runningBrowser is "Safari" then
  tell application "Safari"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        if URL of t starts with "${url}" then
          set current tab of w to t
          set index of w to 1
          do JavaScript "location.reload()" in t
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      open location "${url}"
      activate
    end if
  end tell
else
  open location "${url}"
end if
`;
    if (commandExists("osascript", { env, platform })) {
      try {
        const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
        child.unref();
        return true;
      } catch (_e) {}
    }

    if (commandExists("open", { env, platform })) {
      try {
        const child = spawn("open", [url], { stdio: "ignore", detached: true });
        child.unref();
        return true;
      } catch (_e2) {}
    }
    return false;
  }

  const launch = resolveBrowserLaunchCommand(url, { platform, env, commandExists });
  if (!launch) return false;

  try {
    const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch (_e) {}
  return false;
}

function resolvePostAuthRedirect({ dashboardUrl, authUrl }) {
  try {
    if (dashboardUrl) {
      const target = new URL("/", dashboardUrl);
      if (target.protocol === "http:" || target.protocol === "https:") {
        return target.toString();
      }
      return null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

module.exports = {
  beginBrowserAuth,
  hasGraphicalSession,
  isCommandAvailable,
  isWslSession,
  openInBrowser,
  resolveBrowserLaunchCommand,
};
