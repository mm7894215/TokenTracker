const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

const {
  buildPortInUseHint,
  isPortUnavailableError,
  listenOnAvailablePort,
  NPM_PACKAGE_NAME,
  parseArgs,
} = require("../src/commands/serve");

test("serve port collision hint references the published npm package name", () => {
  assert.equal(NPM_PACKAGE_NAME, "tokentracker-cli");
  assert.equal(
    buildPortInUseHint(7681),
    "Port 7681 is still in use after cleanup. Try: npx tokentracker-cli serve --port 7682\n",
  );
});

test("serve treats Windows EACCES bind failures as port unavailable", () => {
  assert.equal(isPortUnavailableError({ code: "EACCES" }), true);
  assert.equal(isPortUnavailableError({ code: "EADDRINUSE" }), true);
  assert.equal(isPortUnavailableError({ code: "EINVAL" }), false);
});

test("serve default startup falls through to the next available port", async (t) => {
  let occupied = null;
  let occupiedPort = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    occupied = http.createServer((_req, res) => res.end("occupied"));
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    occupiedPort = occupied.address().port;
    if (occupiedPort < 65535 && await canBind(occupiedPort + 1)) {
      break;
    }
    await closeServer(occupied);
    occupied = null;
    occupiedPort = null;
  }
  assert.ok(occupied, "expected to find a free adjacent fallback port");
  t.after(() => closeServer(occupied));

  const server = http.createServer((_req, res) => res.end("fallback"));
  t.after(() => closeServer(server));

  const selectedPort = await listenOnAvailablePort(server, occupiedPort, {
    allowFallback: true,
    maxAttempts: 3,
  });

  assert.equal(selectedPort, occupiedPort + 1);
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

async function canBind(port) {
  const server = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await closeServer(server).catch(() => {});
  }
}

test("serve respects explicit port from --port and PORT env", () => {
  assert.deepEqual(parseArgs([], { PORT: "7700" }), {
    port: 7700,
    portExplicit: true,
    open: true,
    sync: false,
  });
  assert.deepEqual(parseArgs(["--port", "7701", "--no-open", "--sync"], { PORT: "7700" }), {
    port: 7701,
    portExplicit: true,
    open: false,
    sync: true,
  });
  assert.deepEqual(parseArgs(["--no-sync"], {}), {
    port: 7680,
    portExplicit: false,
    open: true,
    sync: false,
  });
  assert.deepEqual(parseArgs([], {}), {
    port: 7680,
    portExplicit: false,
    open: true,
    sync: false,
  });
});
