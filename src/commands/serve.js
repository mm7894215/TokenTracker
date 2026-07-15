const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fssync = require("node:fs");
const cp = require("node:child_process");

const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { createLocalApiHandler, resolveQueuePath } = require("../lib/local-api");
const { ensurePricingLoaded } = require("../lib/pricing");
const { serveStaticFile } = require("../lib/static-server");
const { openInBrowser } = require("../lib/browser-auth");
const { maybeShowStarCta } = require("../lib/star-cta");

const DEFAULT_PORT = 7680;
// Windows Delivery Optimization (DoSvc) listens on 0.0.0.0:7680 on virtually
// every Windows host. Under WSL2 NAT networking the in-WSL bind succeeds (the
// conflict lives on the Windows side of the loopback), but the Windows
// browser reaches DoSvc instead of the dashboard, which accepts the TCP
// connection and drops the HTTP request (#267). The in-WSL "port busy → try
// next" fallback can't see this, so WSL starts one port up by default.
const WSL_DEFAULT_PORT = 7681;
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const NPM_PACKAGE_NAME = "tokentracker-cli";
const LOCAL_BIND_HOST = "127.0.0.1";
const NATIVE_BACKGROUND_SYNC_INTERVAL_MS = 60_000;
const STATIC_ASSET_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".png",
  ".svg",
  ".ttf",
  ".txt",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

function buildPortInUseHint(port) {
  return `Port ${port} is still in use after cleanup. Try: npx ${NPM_PACKAGE_NAME} serve --port ${port + 1}\n`;
}

function isPortUnavailableError(error) {
  return error?.code === "EADDRINUSE" || error?.code === "EACCES" || error?.code === "EPERM";
}

function getLocalServerUrl(port) {
  return `http://${LOCAL_BIND_HOST}:${port}`;
}

async function cmdServe(argv) {
  const opts = parseArgs(argv);

  // 0. First-time setup: if tracker dir doesn't exist, run init first
  const { trackerDir, binDir } = await resolveTrackerPaths();
  if (!fssync.existsSync(path.join(trackerDir, "cursors.json"))) {
    process.stdout.write("First time? Setting up Token Tracker...\n\n");
    try {
      const { cmdInit } = require("./init");
      await cmdInit(["--yes"]);
    } catch (e) {
      process.stdout.write(`Init warning: ${e?.message || e}\n`);
    }
  }

  try {
    const { installLocalTrackerApp, repairRuntimeIntegrations } = require("./init");
    await installLocalTrackerApp({ appDir: path.join(trackerDir, "app") });
    const repairResult = await repairRuntimeIntegrations({ trackerDir, binDir, safeMode: true });
    for (const warning of repairResult?.warnings || []) {
      process.stdout.write(
        `Runtime integration repair warning (${warning.integration}): ${warning.error}\n`,
      );
    }
  } catch (e) {
    process.stdout.write(`Runtime refresh warning: ${e?.message || e}\n`);
  }

  // 1. Optional sync
  if (opts.sync) {
    process.stdout.write("Syncing local data...\n");
    try {
      const { cmdSync } = require("./sync");
      await cmdSync(["--auto"]);
      process.stdout.write("Sync done.\n");
    } catch (e) {
      process.stdout.write(`Sync warning: ${e?.message || e}\n`);
    }
  }

  // 2. Resolve paths
  const queuePath = resolveQueuePath();
  const dashboardDir = resolveDashboardDir();

  // 2.1 Refresh LiteLLM pricing data in the background. The seed snapshot is
  //     already loaded synchronously at require-time, so cost calculation is
  //     functional right now; ensurePricingLoaded() only upgrades to fresh
  //     disk cache or upstream data. Awaiting it here would block startup
  //     for the full 10s fetch timeout when offline / behind a firewall.
  const { cacheDir } = await resolveTrackerPaths();
  ensurePricingLoaded({ cachePath: path.join(cacheDir, "pricing.json") }).catch(
    (e) => process.stdout.write(`Pricing refresh warning: ${e?.message || e}\n`),
  );

  if (!dashboardDir) {
    process.stderr.write(
      [
        "Dashboard not found.",
        "",
        "If you cloned the repo, run:",
        "  cd dashboard && npm run build",
        "",
        "If you installed via npm, the package may be missing dashboard/dist/.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  // 3. Create handler
  const handleApi = createLocalApiHandler({ queuePath });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      // API routes
      if (
        url.pathname.startsWith("/functions/")
        || url.pathname.startsWith("/api/")
        || url.pathname.startsWith("/proxy/")
      ) {
        const handled = await handleApi(req, res, url);
        if (handled) return;
      }

      // Static files
      const served = await serveStaticFile(dashboardDir, url.pathname, res);
      if (served) return;

      // SPA fallback
      if (shouldServeSpaFallback(req, url)) {
        await serveStaticFile(dashboardDir, "/index.html", res);
        return;
      }

      sendNotFound(res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  // 4. Listen. Default startup follows README behavior and picks the next
  // available port; an explicit --port/PORT remains strict.
  if (opts.wslDefaultPort) {
    process.stdout.write(
      `Running under WSL: using port ${opts.port} (7680 is held by the Windows Delivery Optimization service on the host — see issue #267). Pass --port to override.\n`,
    );
  }
  let port;
  try {
    port = await listenOnAvailablePort(server, opts.port, {
      allowFallback: !opts.portExplicit,
      ensurePortFreeFn: opts.portExplicit ? ensurePortFree : null,
      onRetry: (failedPort) => {
        process.stdout.write(`Port ${failedPort} unavailable, trying ${failedPort + 1}...\n`);
      },
    });
  } catch (e) {
    if (isPortUnavailableError(e)) {
      process.stderr.write(buildPortInUseHint(opts.port));
    } else {
      process.stderr.write(`Server error: ${e.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  {
    const url = getLocalServerUrl(port);
    process.stdout.write(
      [
        "",
        `  tokentracker dashboard running at:`,
        "",
        `    ${url}`,
        "",
        `  Data: ${queuePath}`,
        `  Press Ctrl+C to stop.`,
        "",
      ].join("\n"),
    );

    if (opts.open) {
      openInBrowser(url);
    }
  }

  await maybeShowStarCta({ trackerDir });

  // Native desktop apps keep this server alive even when the dashboard window
  // is closed. Provider hooks are the fast path, but they can be removed by a
  // tool update or skipped by a provider. Scan every local source once a
  // minute as a bounded fallback so the queue cannot remain stale indefinitely.
  // `--no-sync` still skips the blocking startup sync; this periodic pass is
  // native-shell-only and uses the lightweight local mode (no cloud upload,
  // Cursor network request, or deep Codex archive scan).
  const nativeBackgroundSync = startNativeBackgroundSync({
    onError: (e) =>
      process.stdout.write(`Background local sync warning: ${e?.message || e}\n`),
  });

  // Anonymous daily heartbeat (see src/lib/telemetry.js for the privacy
  // contract). Fire-and-forget at startup, then re-checked every 6 hours so
  // long-lived embedded-app servers still count on later days; the shared
  // 24h throttle state guarantees at most one send per day.
  {
    const { maybeSendHeartbeat } = require("../lib/telemetry");
    const { trackerDir: heartbeatTrackerDir } = await resolveTrackerPaths();
    const sendHeartbeat = () =>
      maybeSendHeartbeat({ trackerDir: heartbeatTrackerDir }).catch(() => {});
    sendHeartbeat();
    setInterval(sendHeartbeat, 6 * 60 * 60 * 1000).unref();
  }

  server.on("error", (e) => {
    process.stderr.write(`Server error: ${e.message}\n`);
    process.exitCode = 1;
  });

  // 5. Graceful shutdown
  const shutdown = () => {
    process.stdout.write("\nShutting down...\n");
    nativeBackgroundSync?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

function startNativeBackgroundSync({
  appShell = process.env.TOKENTRACKER_APP_SHELL,
  intervalMs = NATIVE_BACKGROUND_SYNC_INTERVAL_MS,
  runSync,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
} = {}) {
  const normalizedShell = String(appShell || "").trim().toLowerCase();
  if (normalizedShell !== "macos" && normalizedShell !== "windows") return null;

  const sync = runSync || (async (args) => {
    const { cmdSync } = require("./sync");
    await cmdSync(args);
  });
  let inFlight = null;
  const run = () => {
    if (inFlight) return inFlight;
    const pending = Promise.resolve()
      .then(() => sync(["--auto", "--background", "--all-local-sources"]))
      .catch((error) => {
        try { onError(error); } catch (_e) {}
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  const timer = setIntervalFn(() => {
    void run();
  }, intervalMs);
  timer?.unref?.();

  return {
    run,
    stop() {
      clearIntervalFn(timer);
    },
  };
}

function findPidOnPort(port) {
  try {
    const out = cp.execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", timeout: 5000 });
    const pids = out.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return pids;
  } catch (_e) {
    return [];
  }
}

async function ensurePortFree(port) {
  const pids = findPidOnPort(port);
  if (pids.length === 0) return;

  // Don't kill ourselves
  const self = process.pid;
  const targets = pids.filter((p) => p !== self);
  if (targets.length === 0) return;

  process.stdout.write(`Stopping previous server on port ${port} (pid ${targets.join(", ")})...\n`);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_e) {}
  }

  // Wait briefly for port to free up
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (findPidOnPort(port).length === 0) return;
  }

  // Force kill if still alive
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_e) {}
  }
  await new Promise((r) => setTimeout(r, 500));
}

function isApiPath(pathname) {
  return (
    pathname.startsWith("/api/")
    || pathname.startsWith("/functions/")
    || pathname.startsWith("/proxy/")
  );
}

function isStaticAssetPath(pathname) {
  if (pathname.startsWith("/assets/")) return true;
  return STATIC_ASSET_EXTENSIONS.has(path.posix.extname(pathname).toLowerCase());
}

function shouldServeSpaFallback(req, url) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const pathname = url.pathname || "/";
  if (isApiPath(pathname) || isStaticAssetPath(pathname)) return false;

  const accept = String(req.headers?.accept || "");
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

function sendNotFound(res) {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Not Found");
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onListening = () => finish(resolve);
    const onError = (error) => finish(reject, error);

    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen(port, host);
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function listenOnAvailablePort(
  server,
  startPort,
  {
    host = LOCAL_BIND_HOST,
    allowFallback = false,
    maxAttempts = DEFAULT_MAX_PORT_ATTEMPTS,
    ensurePortFreeFn = null,
    onRetry = null,
  } = {},
) {
  const attempts = allowFallback ? Math.max(1, maxAttempts) : 1;
  let port = startPort;
  let lastError = null;

  for (let i = 0; i < attempts && port < 65536; i++, port++) {
    if (ensurePortFreeFn) {
      await ensurePortFreeFn(port);
    }

    try {
      await listenOnce(server, port, host);
      return port;
    } catch (error) {
      lastError = error;
      if (!allowFallback || !isPortUnavailableError(error) || port >= 65535) {
        throw error;
      }
      if (typeof onRetry === "function") {
        onRetry(port, error);
      }
    }
  }

  throw lastError || new Error(`No available port found from ${startPort}`);
}

function resolveDashboardDir() {
  const candidates = [
    path.resolve(__dirname, "../../dashboard/dist"),
    path.resolve(__dirname, "../dashboard/dist"),
  ];
  for (const dir of candidates) {
    if (fssync.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function parsePort(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

function isRunningUnderWsl(env = process.env, readFileFn = fssync.readFileSync) {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(String(readFileFn("/proc/version", "utf8")));
  } catch (_e) {
    return false;
  }
}

function resolveDefaultPort(env = process.env, readFileFn) {
  return isRunningUnderWsl(env, readFileFn) ? WSL_DEFAULT_PORT : DEFAULT_PORT;
}

function parseArgs(argv, env = process.env) {
  const envPort = parsePort(env.PORT);
  const defaultPort = resolveDefaultPort(env);
  const opts = {
    port: envPort || defaultPort,
    portExplicit: Boolean(envPort),
    wslDefaultPort: !envPort && defaultPort === WSL_DEFAULT_PORT,
    open: true,
    sync: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const n = parsePort(argv[++i]);
      if (n) {
        opts.port = n;
        opts.portExplicit = true;
        opts.wslDefaultPort = false;
      }
    } else if (arg === "--no-open") {
      opts.open = false;
    } else if (arg === "--no-sync") {
      opts.sync = false;
    }
  }
  return opts;
}

module.exports = {
  cmdServe,
  buildPortInUseHint,
  NPM_PACKAGE_NAME,
  LOCAL_BIND_HOST,
  isPortUnavailableError,
  listenOnAvailablePort,
  getLocalServerUrl,
  parseArgs,
  isRunningUnderWsl,
  resolveDefaultPort,
  shouldServeSpaFallback,
  startNativeBackgroundSync,
  NATIVE_BACKGROUND_SYNC_INTERVAL_MS,
};
