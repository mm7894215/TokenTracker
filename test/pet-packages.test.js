const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const pets = require("../src/lib/pet-packages");

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-pets-test-"));
  process.env.TOKENTRACKER_PETS_DIR = root;
  // Isolate the Codex-side sources so migration / reverse-import never read the real
  // ~/.codex/pets or an installed Codex.app during tests.
  process.env.TOKENTRACKER_CODEX_PETS_DIR = path.join(root, "codex-pets");
  process.env.TOKENTRACKER_CODEX_ASAR = path.join(root, "no-such-app.asar");
});
after(() => {
  delete process.env.TOKENTRACKER_PETS_DIR;
  delete process.env.TOKENTRACKER_CODEX_PETS_DIR;
  delete process.env.TOKENTRACKER_CODEX_ASAR;
  fs.rmSync(root, { recursive: true, force: true });
});

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

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function storeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(contents);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function manifest(id, version = 1) {
  return Buffer.from(JSON.stringify({
    id,
    displayName: id === "v2-pet" ? "V2 Pet" : "V1 Pet",
    description: "A test pet package.",
    spritesheetPath: "spritesheet.webp",
    ...(version === 2 ? { spriteVersionNumber: 2 } : {}),
    kind: "creature",
  }));
}

test("validates V1 and V2 Codex atlas dimensions", () => {
  assert.equal(pets.validatePackageFiles(manifest("v1-pet"), webpHeader(1536, 1872)).manifest.spriteVersionNumber, 1);
  assert.equal(pets.validatePackageFiles(manifest("v2-pet", 2), webpHeader(1536, 2288)).manifest.spriteVersionNumber, 2);
  assert.throws(
    () => pets.validatePackageFiles(manifest("v2-pet", 2), webpHeader(1536, 1872)),
    /1536x2288/,
  );
  const explicitV1 = JSON.parse(manifest("v1-pet").toString("utf8"));
  explicitV1.spriteVersionNumber = 1;
  assert.throws(
    () => pets.validatePackageFiles(Buffer.from(JSON.stringify(explicitV1)), webpHeader(1536, 1872)),
    /must be 2 when provided/,
  );
});

test("imports and discovers an exact two-file standard package", async () => {
  const result = await pets.importPetZip(storeZip({
    "pet.json": manifest("v2-pet", 2),
    "spritesheet.webp": webpHeader(1536, 2288),
  }));
  assert.equal(result.id, "v2-pet");
  assert.equal(result.spriteVersionNumber, 2);
  assert.ok(fs.existsSync(path.join(root, "v2-pet", "pet.json")));
  assert.deepEqual(pets.listInstalledPets().map((pet) => pet.id), ["v2-pet"]);
});

test("rejects non-standard zip entries and reserved ids", async () => {
  await assert.rejects(
    pets.importPetZip(storeZip({
      "pet.json": manifest("extra-pet"),
      "spritesheet.webp": webpHeader(1536, 1872),
      "readme.txt": "unexpected",
    })),
    /only pet.json and spritesheet.webp/,
  );
  assert.throws(
    () => pets.validatePackageFiles(manifest("clawd"), webpHeader(1536, 1872)),
    /reserved/,
  );
});

test("parses only codex-pets.net detail and package URLs", () => {
  assert.equal(pets.petIdFromCodexPetsUrl("https://codex-pets.net/#/pets/samara-v2"), "samara-v2");
  assert.equal(pets.petIdFromCodexPetsUrl("https://codex-pets.net/api/pets/samara-v2/download"), "samara-v2");
  assert.throws(() => pets.petIdFromCodexPetsUrl("https://example.com/#/pets/samara-v2"), /Only/);
});

test("accepts pre-kind manifests and unknown future kinds (codex-pets.net legacy packages)", async () => {
  const legacy = JSON.parse(manifest("nimbus-like").toString("utf8"));
  delete legacy.kind;
  const result = await pets.importPetZip(storeZip({
    "pet.json": Buffer.from(JSON.stringify(legacy)),
    "spritesheet.webp": webpHeader(1536, 1872),
  }));
  assert.equal(result.id, "nimbus-like");
  assert.equal("kind" in result, false);
  const installed = JSON.parse(fs.readFileSync(path.join(root, "nimbus-like", "pet.json"), "utf8"));
  assert.equal("kind" in installed, false);
  assert.ok(pets.listInstalledPets().some((pet) => pet.id === "nimbus-like"));

  const future = { ...legacy, id: "future-kind", kind: "mecha-golem" };
  const futureResult = pets.validatePackageFiles(Buffer.from(JSON.stringify(future)), webpHeader(1536, 1872));
  assert.equal(futureResult.manifest.kind, "mecha-golem");
  assert.throws(
    () => pets.validatePackageFiles(
      Buffer.from(JSON.stringify({ ...legacy, id: "bad-kind", kind: "Not A Slug!" })),
      webpHeader(1536, 1872),
    ),
    /kind must be a short lowercase label/,
  );
});

// --- Codex decoupling: own directory, one-way reverse import (never writes to Codex) ---

async function withCodexEnv(fn) {
  const prev = {
    pets: process.env.TOKENTRACKER_PETS_DIR,
    codex: process.env.TOKENTRACKER_CODEX_PETS_DIR,
    asar: process.env.TOKENTRACKER_CODEX_ASAR,
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-sync-"));
  const ttDir = path.join(base, "tt");
  const codexDir = path.join(base, "codex");
  process.env.TOKENTRACKER_PETS_DIR = ttDir;
  process.env.TOKENTRACKER_CODEX_PETS_DIR = codexDir;
  process.env.TOKENTRACKER_CODEX_ASAR = path.join(base, "none.asar");
  try { return await fn({ base, ttDir, codexDir }); } finally {
    for (const [key, envName] of [["pets", "TOKENTRACKER_PETS_DIR"], ["codex", "TOKENTRACKER_CODEX_PETS_DIR"], ["asar", "TOKENTRACKER_CODEX_ASAR"]]) {
      if (prev[key] === undefined) delete process.env[envName]; else process.env[envName] = prev[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function seedCodexPet(codexDir, id, { version = 2 } = {}) {
  const dir = path.join(codexDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({
    id,
    displayName: id,
    description: "seeded codex pet",
    spritesheetPath: "spritesheet.webp",
    ...(version === 2 ? { spriteVersionNumber: 2 } : {}),
  }));
  fs.writeFileSync(path.join(dir, "spritesheet.webp"), webpHeader(1536, version === 2 ? 2288 : 1872));
}

// Minimal asar writer matching the reader in pet-packages.js (Chromium Pickle prelude).
function buildAsar(entries) {
  const tree = { files: {} };
  const chunks = [];
  let dataOffset = 0;
  for (const [rel, buf] of Object.entries(entries)) {
    const parts = rel.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} };
      node = node.files[parts[i]];
    }
    node.files[parts[parts.length - 1]] = { size: buf.length, offset: String(dataOffset) };
    chunks.push(buf);
    dataOffset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(tree), "utf8");
  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(json.length + 8, 4);
  prelude.writeUInt32LE(json.length + 4, 8);
  prelude.writeUInt32LE(json.length, 12);
  const base = 16 + json.length;
  const pad = Buffer.alloc(base % 4 ? 4 - (base % 4) : 0);
  return Buffer.concat([prelude, json, pad, ...chunks]);
}

test("pets live in TokenTracker's own directory, not ~/.codex/pets", () => {
  const home = os.homedir();
  const previous = process.env.TOKENTRACKER_PETS_DIR;
  const previousCodex = process.env.TOKENTRACKER_CODEX_PETS_DIR;
  delete process.env.TOKENTRACKER_PETS_DIR;
  delete process.env.TOKENTRACKER_CODEX_PETS_DIR;
  try {
    assert.equal(pets.resolvePetsDir(), path.join(home, ".tokentracker", "pets"));
    assert.equal(pets.resolveCodexPetsDir(), path.join(home, ".codex", "pets"));
  } finally {
    process.env.TOKENTRACKER_PETS_DIR = previous;
    process.env.TOKENTRACKER_CODEX_PETS_DIR = previousCodex;
  }
});

test("install never writes to Codex (TokenTracker stays independent)", async () => {
  await withCodexEnv(async ({ ttDir, codexDir }) => {
    await pets.importPetZip(storeZip({
      "pet.json": manifest("stayhome", 2),
      "spritesheet.webp": webpHeader(1536, 2288),
    }));
    assert.ok(fs.existsSync(path.join(ttDir, "stayhome")), "pet saved in TokenTracker dir");
    assert.ok(!fs.existsSync(path.join(codexDir, "stayhome")), "pet must NOT leak into Codex");
  });
});

test("one-time migration copies legacy Codex pets into the local dir", async () => {
  await withCodexEnv(({ ttDir, codexDir }) => {
    seedCodexPet(codexDir, "legacy-a", { version: 2 });
    seedCodexPet(codexDir, "legacy-b", { version: 1 });
    fs.mkdirSync(path.join(codexDir, "byte")); // reserved id — must be skipped
    const first = pets.listInstalledPets().map((pet) => pet.id).sort();
    assert.deepEqual(first, ["legacy-a", "legacy-b"]);
    assert.ok(fs.existsSync(path.join(ttDir, ".migrated-v1")));
    // Idempotent: a new legacy pet added after the marker is NOT re-migrated.
    seedCodexPet(codexDir, "legacy-c", { version: 2 });
    assert.deepEqual(pets.listInstalledPets().map((pet) => pet.id).sort(), ["legacy-a", "legacy-b"]);
  });
});

test("one-time migration retries after a transient legacy-directory read failure", async () => {
  await withCodexEnv(({ ttDir, codexDir }) => {
    seedCodexPet(codexDir, "retry-me", { version: 2 });
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function failingLegacyRead(directory, ...args) {
      if (path.resolve(String(directory)) === path.resolve(codexDir)) {
        const error = new Error("temporary read failure");
        error.code = "EIO";
        throw error;
      }
      return originalReaddirSync.call(this, directory, ...args);
    };
    try {
      assert.deepEqual(pets.listInstalledPets(), []);
      assert.ok(!fs.existsSync(path.join(ttDir, ".migrated-v1")));
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.deepEqual(pets.listInstalledPets().map((pet) => pet.id), ["retry-me"]);
    assert.ok(fs.existsSync(path.join(ttDir, ".migrated-v1")));
  });
});

test("resolving a persisted legacy pet triggers migration before the first catalog request", async () => {
  await withCodexEnv(({ ttDir, codexDir }) => {
    seedCodexPet(codexDir, "persisted", { version: 2 });

    const resolved = pets.resolvePetAsset("persisted");

    assert.equal(resolved?.manifest.id, "persisted");
    assert.ok(fs.existsSync(path.join(ttDir, "persisted", "spritesheet.webp")));
    assert.ok(fs.existsSync(path.join(ttDir, ".migrated-v1")));
  });
});

test("Codex preview assets receive the same package validation as imports", async () => {
  await withCodexEnv(({ codexDir }) => {
    const invalidDir = path.join(codexDir, "invalid-preview");
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(path.join(invalidDir, "pet.json"), JSON.stringify({
      id: "invalid-preview",
      displayName: "Invalid preview",
      description: "not a spritesheet",
      spritesheetPath: "spritesheet.webp",
      spriteVersionNumber: 2,
    }));
    fs.writeFileSync(path.join(invalidDir, "spritesheet.webp"), "not-webp");

    assert.equal(pets.readCodexImportableAsset("invalid-preview"), null);
  });
});

test("reverse-imports pets from ~/.codex/pets and from a Codex.app asar", async () => {
  await withCodexEnv(({ ttDir, codexDir, base }) => {
    // Simulate a machine where the one-time migration already ran, then the user
    // installs a new pet through Codex — it should appear as importable, not be
    // silently auto-migrated.
    fs.mkdirSync(ttDir, { recursive: true });
    fs.writeFileSync(path.join(ttDir, ".migrated-v1"), "done\n");
    // A Codex-dir pet (installed via Codex), plus a bundled app pet inside a fake asar.
    seedCodexPet(codexDir, "fromdir", { version: 2 });
    const asarPath = path.join(base, "codex.asar");
    fs.writeFileSync(asarPath, buildAsar({
      "webview/assets/rocky-spritesheet-v5-abc.webp": webpHeader(1536, 2288),
    }));
    process.env.TOKENTRACKER_CODEX_ASAR = asarPath;

    const originalOpenSync = fs.openSync;
    let asarOpenCount = 0;
    fs.openSync = function countedOpenSync(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(asarPath)) asarOpenCount += 1;
      return originalOpenSync.call(this, file, ...args);
    };

    try {
      const builtin = pets.readCodexBuiltinPets(asarPath);
      assert.deepEqual(builtin.map((pet) => pet.id), ["rocky"]);
      assert.equal(builtin[0].displayName, "Rocky");
      assert.equal(builtin[0].spriteVersionNumber, 2);

      const importable = pets.listCodexImportablePets().map((pet) => `${pet.id}:${pet.source}`).sort();
      assert.deepEqual(importable, ["fromdir:codex-dir", "rocky:codex-app"]);

      const result = pets.importFromCodex(["fromdir", "rocky"]);
      assert.deepEqual(result.imported.map((pet) => pet.id).sort(), ["fromdir", "rocky"]);
      assert.ok(fs.existsSync(path.join(ttDir, "rocky", "spritesheet.webp")));
      assert.ok(fs.existsSync(path.join(ttDir, "fromdir", "spritesheet.webp")));
      // Already-imported pets drop out of the importable list.
      assert.deepEqual(pets.listCodexImportablePets(), []);
      assert.equal(asarOpenCount, 1, "one parsed asar should serve listing, preview, and import");
    } finally {
      fs.openSync = originalOpenSync;
    }
  });
});

test("reverse import never overwrites an existing TokenTracker pet", async () => {
  await withCodexEnv(async ({ ttDir, codexDir }) => {
    fs.mkdirSync(ttDir, { recursive: true });
    fs.writeFileSync(path.join(ttDir, ".migrated-v1"), "done\n");
    await pets.importPetZip(storeZip({
      "pet.json": manifest("protected"),
      "spritesheet.webp": webpHeader(1536, 1872),
    }));
    const localSprite = fs.readFileSync(path.join(ttDir, "protected", "spritesheet.webp"));
    seedCodexPet(codexDir, "protected", { version: 2 });

    assert.throws(() => pets.importFromCodex(["protected"]), /already installed/);
    assert.deepEqual(
      fs.readFileSync(path.join(ttDir, "protected", "spritesheet.webp")),
      localSprite,
    );
  });
});

test("removing a pet only touches TokenTracker's dir, never Codex", async () => {
  await withCodexEnv(async ({ ttDir, codexDir }) => {
    seedCodexPet(codexDir, "codex-native", { version: 2 }); // Codex's own — must survive
    await pets.importPetZip(storeZip({
      "pet.json": manifest("mine", 2),
      "spritesheet.webp": webpHeader(1536, 2288),
    }));
    pets.removeInstalledPet("mine");
    assert.ok(!fs.existsSync(path.join(ttDir, "mine")), "local pet removed");
    assert.ok(fs.existsSync(path.join(codexDir, "codex-native")), "Codex pet untouched");
  });
});
