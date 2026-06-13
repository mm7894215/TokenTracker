const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;

  process.nextTick(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });

  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function getLocalAuthToken(handler) {
  const req = createRequest({ method: "GET" });
  const res = createResponse();
  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = JSON.parse(res.body.toString("utf8"));
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  return body.token;
}

function loadLocalApiWithSpawn(fakeSpawn) {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = fakeSpawn;
  delete require.cache[require.resolve("../src/lib/local-api")];
  const mod = require("../src/lib/local-api");
  return {
    mod,
    restore() {
      childProcess.spawn = originalSpawn;
      delete require.cache[require.resolve("../src/lib/local-api")];
    },
  };
}

function createSuccessfulSpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", "sync ok");
      child.emit("close", 0);
    });
    return child;
  };
}

test("local sync rejects arbitrary insforgeBaseUrl overrides", async () => {
  const calls = [];
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://allowed.example";
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        insforgeBaseUrl: "https://evil.example",
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unsupported insforgeBaseUrl override",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
  }
});

test("local sync accepts the configured insforgeBaseUrl override", async () => {
  const calls = [];
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://allowed.example";

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        insforgeBaseUrl: "https://allowed.example/",
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].options.env.TOKENTRACKER_INSFORGE_BASE_URL,
      "https://allowed.example",
    );
  } finally {
    restore();
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
  }
});

test("local sync drain request runs sync with --drain", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({
        deviceToken: "device-token",
        drain: true,
      }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--drain"]);
  } finally {
    restore();
  }
});

test("local sync only treats boolean true as drain", async () => {
  const cases = [
    {},
    { drain: false },
    { drain: "true" },
    { drain: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({
          deviceToken: "device-token",
          ...body,
        }),
      });
      const res = createResponse();

      const handled = await handler(
        req,
        res,
        new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
      );

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-2), [path.join(process.cwd(), "bin/tracker.js"), "sync"]);
    } finally {
      restore();
    }
  }
});

test("local sync drain request mints a device token from relayed login when none is provided", async () => {
  const calls = [];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-drain-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = global.fetch;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ machineId: "machine-abcdef12" }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  const fetchCalls = [];
  global.fetch = async (urlStr, opts = {}) => {
    fetchCalls.push({ url: String(urlStr), opts });
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      assert.equal(opts.headers.Authorization, "Bearer access-token");
      const body = JSON.parse(String(opts.body || "{}"));
      assert.equal(body.machine_id, "machine-abcdef12");
      assert.equal(body.device_name, "Token Tracker (dashboard) #machine-");
      assert.equal(
        body.platform,
        process.platform === "darwin" ? "MacIntel" :
          process.platform === "win32" ? "Win32" :
            process.platform === "linux" ? "Linux x86_64" :
              "web",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "issued-device-token", device_id: "device-id" }),
      };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-3), [path.join(process.cwd(), "bin/tracker.js"), "sync", "--drain"]);
    assert.equal(calls[0].options.env.TOKENTRACKER_DEVICE_TOKEN, "issued-device-token");
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/api/auth/refresh?client_type=mobile")));
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/functions/tokentracker-device-token-issue")));
  } finally {
    restore();
    global.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("local sync drain request fails when relayed device token cannot be issued", async () => {
  const calls = [];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-sync-drain-fail-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = global.fetch;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";

  const trackerDir = path.join(tmpHome, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ machineId: "machine-abcdef12" }));
  fs.writeFileSync(
    path.join(trackerDir, "relay-cookies.json"),
    JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=refresh-xyz; Path=/; HttpOnly; SameSite=Lax",
    }),
  );

  global.fetch = async (urlStr) => {
    if (String(urlStr) === "https://cloud.example/api/auth/refresh?client_type=mobile") {
      return { ok: true, status: 200, json: async () => ({ accessToken: "access-token" }) };
    }
    if (String(urlStr) === "https://cloud.example/functions/tokentracker-device-token-issue") {
      return { ok: false, status: 502, json: async () => ({ error: "upstream unavailable" }) };
    }
    throw new Error(`unexpected fetch ${urlStr}`);
  };

  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({
      queuePath: path.join(trackerDir, "queue.jsonl"),
    });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ drain: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unable to issue cloud device token for drain sync",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
    global.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("local sync rejects requests without the local auth token", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({
      method: "POST",
      body: JSON.stringify({ deviceToken: "device-token" }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/functions/tokentracker-local-sync"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
      ok: false,
      error: "Unauthorized",
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("auth bridge mutation requires the local auth token", async () => {
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn([]));

  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({
      method: "PUT",
      body: JSON.stringify({ native: true }),
    });
    const res = createResponse();

    const handled = await handler(
      req,
      res,
      new URL("http://127.0.0.1/api/auth-bridge/verifier"),
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { error: "Unauthorized" });
  } finally {
    restore();
  }
});
