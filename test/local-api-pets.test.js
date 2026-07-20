const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-pets-"));
process.env.TOKENTRACKER_PETS_DIR = path.join(sandbox, "pets");
// Keep the Codex-side sources isolated so tests never touch a real Codex install.
process.env.TOKENTRACKER_CODEX_PETS_DIR = path.join(sandbox, "codex-pets");
process.env.TOKENTRACKER_CODEX_ASAR = path.join(sandbox, "no-such-app.asar");
const { createLocalApiHandler } = require("../src/lib/local-api");

function webpHeader(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function seedPet() {
  const directory = path.join(process.env.TOKENTRACKER_PETS_DIR, "api-v2-pet");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "pet.json"), JSON.stringify({
    id: "api-v2-pet",
    displayName: "API V2 Pet",
    description: "A local API test pet.",
    spritesheetPath: "spritesheet.webp",
    spriteVersionNumber: 2,
    kind: "creature",
  }));
  fs.writeFileSync(path.join(directory, "spritesheet.webp"), webpHeader(1536, 2288));
}

function seedCodexPet() {
  const directory = path.join(process.env.TOKENTRACKER_CODEX_PETS_DIR, "codex-import");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "pet.json"), JSON.stringify({
    id: "codex-import",
    displayName: "Codex Import",
    description: "A reverse-import API test pet.",
    spritesheetPath: "spritesheet.webp",
    spriteVersionNumber: 2,
  }));
  fs.writeFileSync(path.join(directory, "spritesheet.webp"), webpHeader(1536, 2288));
}

function request({ method = "GET", pathname, headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}`);
  const listeners = {};
  const req = {
    method,
    headers: { host: "localhost", ...headers },
    on(event, listener) { listeners[event] = listener; return req; },
  };
  process.nextTick(() => {
    if (body != null) listeners.data?.(Buffer.from(JSON.stringify(body)));
    listeners.end?.();
  });
  return { req, url };
}

function response() {
  let status = 200;
  let body = "";
  return {
    writeHead(code) { status = code; },
    end(chunk) { if (chunk) body += chunk; },
    get result() { return { status, body: body ? JSON.parse(body) : null }; },
  };
}

async function call(handler, options) {
  const { req, url } = request(options);
  const res = response();
  assert.equal(await handler(req, res, url), true);
  return res.result;
}

describe("local Codex pet API", () => {
  let handler;
  let token;

  before(async () => {
    seedPet();
    handler = createLocalApiHandler({ queuePath: path.join(sandbox, "queue.jsonl") });
    token = (await call(handler, { pathname: "/api/local-auth" })).body.token;
  });

  after(() => {
    delete process.env.TOKENTRACKER_PETS_DIR;
    delete process.env.TOKENTRACKER_CODEX_PETS_DIR;
    delete process.env.TOKENTRACKER_CODEX_ASAR;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("lists valid V2 packages with a versioned same-origin asset URL", async () => {
    const result = await call(handler, { pathname: "/functions/tokentracker-pets" });
    assert.equal(result.status, 200);
    assert.equal(result.body.pets[0].id, "api-v2-pet");
    assert.equal(result.body.pets[0].spriteVersionNumber, 2);
    assert.match(result.body.pets[0].assetUrl, /^\/api\/pets\/local\/api-v2-pet\/spritesheet\.webp\?v=/);
  });

  it("lists, previews, and protects reverse imports from Codex", async () => {
    seedCodexPet();
    const listed = await call(handler, { pathname: "/functions/tokentracker-pets?scope=codex" });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.codexDetected, true);
    assert.equal(listed.body.importable[0].id, "codex-import");
    assert.match(listed.body.importable[0].assetUrl, /^\/api\/pets\/codex\/codex-import\/spritesheet\.webp\?v=/);

    const preview = await call(handler, {
      method: "HEAD",
      pathname: "/api/pets/codex/codex-import/spritesheet.webp",
    });
    assert.equal(preview.status, 200);

    const unauthorized = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-pets",
      headers: { origin: "http://localhost:7680" },
      body: { action: "import_codex", ids: ["codex-import"] },
    });
    assert.equal(unauthorized.status, 401);

    const imported = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-pets",
      headers: { origin: "http://localhost:7680", "x-tokentracker-local-auth": token },
      body: { action: "import_codex", ids: ["codex-import"] },
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body.imported.map((pet) => pet.id), ["codex-import"]);
    assert.equal(fs.existsSync(path.join(process.env.TOKENTRACKER_PETS_DIR, "codex-import")), true);
  });

  it("protects removal with loopback local auth", async () => {
    const unauthorized = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-pets",
      headers: { origin: "http://localhost:7680" },
      body: { action: "remove", id: "api-v2-pet" },
    });
    assert.equal(unauthorized.status, 401);

    const removed = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-pets",
      headers: { origin: "http://localhost:7680", "x-tokentracker-local-auth": token },
      body: { action: "remove", id: "api-v2-pet" },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(fs.existsSync(path.join(process.env.TOKENTRACKER_PETS_DIR, "api-v2-pet")), false);
  });
});
