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

const DEFAULT_PORT = 7680;
const NPM_PACKAGE_NAME = "tokentracker-cli";
const LOCAL_BIND_HOST = "127.0.0.1";

function buildPortInUseHint(port) {
  return `Port ${port} is still in use after cleanup. Try: npx ${NPM_PACKAGE_NAME} serve --port ${port + 1}\n`;
}

function getLocalServerUrl(port) {
  return `http://${LOCAL_BIND_HOST}:${port}`;
}

async function cmdServe(argv) {
  const opts = parseArgs(argv);

  // 0. First-time setup: if tracker dir doesn't exist, run init first
  const { trackerDir } = await resolveTrackerPaths();
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
    const { installLocalTrackerApp } = require("./init");
    await installLocalTrackerApp({ appDir: path.join(trackerDir, "app") });
  } catch (e) {
    process.stdout.write(`Runtime refresh warning: ${e?.message || e}\n`);
  }

  // 0.1 Ensure config.json baseUrl matches the canonical default
  try {
    const { DEFAULT_BASE_URL } = require("../lib/runtime-config");
    const { readJson, writeJson } = require("../lib/fs");
    const cfgPath = path.join(trackerDir, "config.json");
    const cfg = await readJson(cfgPath);
    if (cfg && cfg.baseUrl !== DEFAULT_BASE_URL) {
      cfg.baseUrl = DEFAULT_BASE_URL;
      await writeJson(cfgPath, cfg);
    }
  } catch { /* ignore */ }

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
      if (url.pathname.startsWith("/functions/") || url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (handled) return;
      }

      // Static files
      const served = await serveStaticFile(dashboardDir, url.pathname, res);
      if (served) return;

      // SPA fallback
      await serveStaticFile(dashboardDir, "/index.html", res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  // 4. Listen (kill stale process on same port if needed)
  const port = opts.port;
  await ensurePortFree(port);
  server.listen(port, LOCAL_BIND_HOST, () => {
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
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(buildPortInUseHint(port));
    } else {
      process.stderr.write(`Server error: ${e.message}\n`);
    }
    process.exitCode = 1;
  });

  // 5. Graceful shutdown
  const shutdown = () => {
    process.stdout.write("\nShutting down...\n");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
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

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, open: true, sync: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) opts.port = n;
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
  getLocalServerUrl,
};
