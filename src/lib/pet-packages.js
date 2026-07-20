const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const yauzl = require("yauzl");

const PET_MANIFEST = "pet.json";
const PET_SPRITESHEET = "spritesheet.webp";
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SPRITESHEET_BYTES = 10 * 1024 * 1024;
const BUILTIN_IDS = new Set(["clawd", "sprout", "byte", "ember"]);
// codex-pets.net added `kind` to pet.json long after launch, and its enum may keep
// growing — packages published before that (and future kinds) must stay importable,
// so kind is optional metadata validated only as a short slug.
const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
const PET_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const petDirectoryCache = new Map();
let codexAsarCache = null;

// TokenTracker keeps its own pets under ~/.tokentracker/pets and never writes to the
// Codex app: URL/zip imports stay here, and Codex is only ever read from (reverse
// import). `~/.codex/pets` is reachable purely as an import source.
const MIGRATION_MARKER = ".migrated-v1";

function resolvePetsDir() {
  return path.resolve(
    process.env.TOKENTRACKER_PETS_DIR || path.join(os.homedir(), ".tokentracker", "pets"),
  );
}

function resolveCodexPetsDir() {
  return path.resolve(
    process.env.TOKENTRACKER_CODEX_PETS_DIR || path.join(os.homedir(), ".codex", "pets"),
  );
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebpDimensions(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 30
    || buffer.subarray(0, 4).toString("ascii") !== "RIFF"
    || buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new Error("spritesheet.webp is not a valid WebP file");
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new Error("spritesheet.webp has an invalid RIFF size");
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + size > buffer.length) throw new Error("spritesheet.webp is truncated");
    if (type === "VP8X" && size >= 10) {
      return {
        width: readUInt24LE(buffer, data + 4) + 1,
        height: readUInt24LE(buffer, data + 7) + 1,
      };
    }
    if (type === "VP8 " && size >= 10) {
      if (buffer[data + 3] !== 0x9d || buffer[data + 4] !== 0x01 || buffer[data + 5] !== 0x2a) {
        throw new Error("spritesheet.webp has an invalid VP8 frame header");
      }
      return {
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
      };
    }
    if (type === "VP8L" && size >= 5) {
      if (buffer[data] !== 0x2f) throw new Error("spritesheet.webp has an invalid VP8L header");
      const bits = buffer.readUInt32LE(data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    offset = data + size + (size % 2);
  }
  throw new Error("spritesheet.webp has no decodable image frame");
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pet.json must contain a JSON object");
  }
  const id = String(value.id || "").trim().toLowerCase();
  const displayName = String(value.displayName || "").trim();
  const description = String(value.description || "").trim();
  const spritesheetPath = String(value.spritesheetPath || "").trim();
  const kind = String(value.kind || "").trim().toLowerCase();
  const versionProvided = value.spriteVersionNumber !== undefined;
  const spriteVersionNumber = versionProvided ? value.spriteVersionNumber : 1;

  if (!PET_ID_RE.test(id)) throw new Error("pet.json id must be a lowercase URL-safe slug");
  if (BUILTIN_IDS.has(id)) throw new Error(`${id} is reserved by a built-in TokenTracker pet`);
  if (!displayName || displayName.length > 80) throw new Error("pet.json displayName is required and must be at most 80 characters");
  if (!description || description.length > 280) throw new Error("pet.json description is required and must be at most 280 characters");
  if (spritesheetPath !== PET_SPRITESHEET) throw new Error("pet.json spritesheetPath must be spritesheet.webp");
  if (kind && !KIND_RE.test(kind)) throw new Error("pet.json kind must be a short lowercase label when provided");
  if (versionProvided && spriteVersionNumber !== 2) {
    throw new Error("pet.json spriteVersionNumber must be 2 when provided");
  }

  return {
    id,
    displayName,
    description,
    spritesheetPath: PET_SPRITESHEET,
    spriteVersionNumber,
    ...(kind ? { kind } : {}),
  };
}

function validatePackageFiles(manifestBuffer, spritesheetBuffer) {
  if (!Buffer.isBuffer(manifestBuffer) || manifestBuffer.length === 0 || manifestBuffer.length > MAX_MANIFEST_BYTES) {
    throw new Error("pet.json is missing or too large");
  }
  if (!Buffer.isBuffer(spritesheetBuffer) || spritesheetBuffer.length === 0 || spritesheetBuffer.length > MAX_SPRITESHEET_BYTES) {
    throw new Error("spritesheet.webp is missing or too large");
  }

  let parsed;
  try {
    parsed = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    throw new Error("pet.json is not valid JSON");
  }
  const manifest = normalizeManifest(parsed);
  const dimensions = readWebpDimensions(spritesheetBuffer);
  const expectedHeight = manifest.spriteVersionNumber === 2 ? 2288 : 1872;
  if (dimensions.width !== 1536 || dimensions.height !== expectedHeight) {
    throw new Error(
      `spritesheet.webp must be 1536x${expectedHeight} for a v${manifest.spriteVersionNumber} pet`,
    );
  }
  return { manifest, dimensions };
}

function readZipEntries(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0 || zipBuffer.length > MAX_PACKAGE_BYTES) {
    return Promise.reject(new Error("Pet package is empty or exceeds 12 MB"));
  }
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zipfile) => {
      if (openError) return reject(new Error(`Invalid pet package: ${openError.message}`));
      const entries = new Map();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch {}
        reject(error);
      };
      zipfile.on("error", (error) => fail(new Error(`Invalid pet package: ${error.message}`)));
      zipfile.on("entry", (entry) => {
        const name = String(entry.fileName || "");
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) {
          fail(new Error("Pet package entries must not be symbolic links"));
          return;
        }
        if (name !== PET_MANIFEST && name !== PET_SPRITESHEET) {
          fail(new Error("A standard pet package must contain only pet.json and spritesheet.webp at its root"));
          return;
        }
        if (entries.has(name)) {
          fail(new Error(`Pet package contains duplicate ${name}`));
          return;
        }
        const limit = name === PET_MANIFEST ? MAX_MANIFEST_BYTES : MAX_SPRITESHEET_BYTES;
        if (entry.uncompressedSize <= 0 || entry.uncompressedSize > limit) {
          fail(new Error(`${name} is empty or too large`));
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(new Error(`Could not read ${name}: ${streamError.message}`));
          const chunks = [];
          let total = 0;
          stream.on("data", (chunk) => {
            total += chunk.length;
            if (total > limit) {
              stream.destroy(new Error(`${name} is too large`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", (error) => fail(error));
          stream.on("end", () => {
            if (settled) return;
            entries.set(name, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => {
        if (settled) return;
        settled = true;
        if (entries.size !== 2 || !entries.has(PET_MANIFEST) || !entries.has(PET_SPRITESHEET)) {
          reject(new Error("Pet package must contain pet.json and spritesheet.webp"));
          return;
        }
        resolve(entries);
      });
      zipfile.readEntry();
    });
  });
}

function publicPet(manifest, extra = {}) {
  const assetVersion = extra.assetVersion || "";
  return {
    ...manifest,
    custom: true,
    assetUrl: `/api/pets/local/${encodeURIComponent(manifest.id)}/${PET_SPRITESHEET}${assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : ""}`,
    ...extra,
  };
}

function loadPetDirectory(directory, expectedId = null) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pet path is not a directory");
  const manifestPath = path.join(directory, PET_MANIFEST);
  const spritesheetPath = path.join(directory, PET_SPRITESHEET);
  const manifestStat = fs.lstatSync(manifestPath);
  const spriteStat = fs.lstatSync(spritesheetPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !spriteStat.isFile() || spriteStat.isSymbolicLink()) {
    throw new Error("Pet assets must be regular files");
  }
  if (manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("pet.json is missing or too large");
  }
  if (spriteStat.size <= 0 || spriteStat.size > MAX_SPRITESHEET_BYTES) {
    throw new Error("spritesheet.webp is missing or too large");
  }
  const cacheKey = [
    manifestStat.mtimeMs,
    manifestStat.size,
    spriteStat.mtimeMs,
    spriteStat.size,
  ].join(":");
  const cacheId = directory;
  const cached = petDirectoryCache.get(cacheId);
  if (cached?.cacheKey === cacheKey) return cached.value;
  const result = validatePackageFiles(fs.readFileSync(manifestPath), fs.readFileSync(spritesheetPath));
  if (expectedId && result.manifest.id !== expectedId) throw new Error("Pet directory and manifest id do not match");
  const value = {
    ...result,
    directory,
    spritesheetPath,
    assetVersion: `${Math.trunc(spriteStat.mtimeMs)}-${spriteStat.size}`,
  };
  petDirectoryCache.set(cacheId, { cacheKey, value });
  return value;
}

function listInstalledPets() {
  migrateLegacyCodexPets();
  const root = resolvePetsDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const pets = [];
  for (const name of names) {
    if (!PET_ID_RE.test(name) || BUILTIN_IDS.has(name)) continue;
    try {
      const loaded = loadPetDirectory(path.join(root, name), name);
      pets.push(publicPet(loaded.manifest, { assetVersion: loaded.assetVersion }));
    } catch {
      // Invalid or partially copied directories are ignored until they become valid.
    }
  }
  return pets.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Atomically writes one validated pet into `root` (staged dir → rename), optionally
// dropping `markerName` inside the pet directory. Returns the loaded asset info.
function writePetIntoDir(root, manifest, spritesheetBuffer, markerName = null) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = path.join(root, `.tokentracker-pet-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  const destination = path.join(root, manifest.id);
  const backup = `${stage}-backup`;
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(stage, PET_MANIFEST), `${JSON.stringify({
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      spritesheetPath: PET_SPRITESHEET,
      ...(manifest.spriteVersionNumber === 2 ? { spriteVersionNumber: 2 } : {}),
      kind: manifest.kind,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stage, PET_SPRITESHEET), spritesheetBuffer, { mode: 0o600 });
    if (markerName) fs.writeFileSync(path.join(stage, markerName), "", { mode: 0o600 });
    loadPetDirectory(stage, manifest.id);
    petDirectoryCache.delete(destination);
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    fs.renameSync(stage, destination);
    petDirectoryCache.delete(stage);
  } catch (error) {
    petDirectoryCache.delete(stage);
    fs.rmSync(stage, { recursive: true, force: true });
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
  return loadPetDirectory(destination, manifest.id);
}

function installValidatedPackage(manifestBuffer, spritesheetBuffer) {
  const { manifest } = validatePackageFiles(manifestBuffer, spritesheetBuffer);
  const installed = writePetIntoDir(resolvePetsDir(), manifest, spritesheetBuffer);
  return publicPet(manifest, { assetVersion: installed.assetVersion });
}

async function importPetZip(zipBuffer) {
  const entries = await readZipEntries(zipBuffer);
  return installValidatedPackage(entries.get(PET_MANIFEST), entries.get(PET_SPRITESHEET));
}

function petIdFromCodexPetsUrl(input) {
  const raw = String(input || "").trim();
  if (PET_ID_RE.test(raw)) return raw;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("Enter a Codex Pets URL or pet id"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "codex-pets.net") {
    throw new Error("Only https://codex-pets.net pet URLs are supported");
  }
  const hashMatch = parsed.hash.match(/^#\/pets\/([a-z0-9-]+)\/?$/i);
  const pathMatch = parsed.pathname.match(/^\/api\/pets\/([a-z0-9-]+)(?:\/download)?\/?$/i);
  const id = String(hashMatch?.[1] || pathMatch?.[1] || "").toLowerCase();
  if (!PET_ID_RE.test(id)) throw new Error("The Codex Pets URL does not contain a valid pet id");
  return id;
}

async function installFromCodexPets(input, fetchImpl = fetch) {
  const id = petIdFromCodexPetsUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`https://codex-pets.net/api/pets/${encodeURIComponent(id)}/download`, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/zip", "user-agent": "TokenTracker Pet Importer" },
    });
    if (!response.ok) throw new Error(`Codex Pets download failed with HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_PACKAGE_BYTES) throw new Error("Pet package exceeds 12 MB");
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > MAX_PACKAGE_BYTES) throw new Error("Pet package exceeds 12 MB");
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    return await importPetZip(body);
  } finally {
    clearTimeout(timeout);
  }
}

function removeInstalledPet(id) {
  const normalized = String(id || "").trim().toLowerCase();
  if (!PET_ID_RE.test(normalized) || BUILTIN_IDS.has(normalized)) throw new Error("Invalid custom pet id");
  const root = resolvePetsDir();
  const destination = path.join(root, normalized);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Invalid custom pet path");
  fs.rmSync(destination, { recursive: true, force: true });
  petDirectoryCache.delete(destination);
  return { id: normalized };
}

function resolvePetAsset(id) {
  // Native hosts can ask for the persisted custom pet before the dashboard has
  // listed the catalog. Migrate first so an upgrade does not turn that first
  // request into a 404 and reset the user's selection.
  migrateLegacyCodexPets();
  const normalized = String(id || "").trim().toLowerCase();
  if (!PET_ID_RE.test(normalized) || BUILTIN_IDS.has(normalized)) return null;
  try { return loadPetDirectory(path.join(resolvePetsDir(), normalized), normalized); } catch { return null; }
}

// --- One-time migration: copy legacy pets out of the shared Codex dir into our own ---

function migrateLegacyCodexPets() {
  const root = resolvePetsDir();
  const marker = path.join(root, MIGRATION_MARKER);
  try { if (fs.existsSync(marker)) return { migrated: 0 }; } catch { return { migrated: 0 }; }
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { return { migrated: 0 }; }
  let migrated = 0;
  let names = [];
  let scanComplete = false;
  try {
    names = fs.readdirSync(resolveCodexPetsDir());
    scanComplete = true;
  } catch (error) {
    // A missing legacy directory is a completed no-op. Permission and I/O
    // failures are not: leave the marker absent so the next launch can retry.
    if (error?.code === "ENOENT") scanComplete = true;
  }
  let copyFailed = false;
  for (const name of names) {
    if (!PET_ID_RE.test(name) || BUILTIN_IDS.has(name)) continue;
    if (fs.existsSync(path.join(root, name))) continue; // never clobber an existing local pet
    let loaded;
    try {
      loaded = loadPetDirectory(path.join(resolveCodexPetsDir(), name), name);
    } catch {
      // Invalid legacy packages are ignored just as they were by the old catalog.
      continue;
    }
    try {
      writePetIntoDir(root, loaded.manifest, fs.readFileSync(loaded.spritesheetPath));
      migrated += 1;
    } catch {
      copyFailed = true;
    }
  }
  if (scanComplete && !copyFailed) {
    try { fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch {}
  }
  return { migrated };
}

// --- Reverse import: pull Codex's own pets into TokenTracker ---

// Resolved per call (not frozen at load) so an env override applies at runtime.
function resolveCodexAsarPath() {
  return process.env.TOKENTRACKER_CODEX_ASAR
    || "/Applications/Codex.app/Contents/Resources/app.asar";
}
// Codex ships these native companions bundled inside its app; the display names are
// stable brand labels. Anything not listed falls back to a capitalized id.
const CODEX_BUILTIN_NAMES = {
  rocky: "Rocky", seedy: "Seedy", hoots: "Hoots", dewey: "Dewey", fireball: "Fireball",
  stacky: "Stacky", codex: "Codex", bsod: "BSOD", "null-signal": "Null Signal",
};

// Parses the asar header (Chromium Pickle) and returns the file tree plus the byte
// offset where file contents begin. Pure Node, no dependency — asar's layout is stable.
function readAsarHeader(fd) {
  const head = Buffer.alloc(16);
  if (fs.readSync(fd, head, 0, 16, 0) < 16) throw new Error("asar too small");
  const headerPayloadSize = head.readUInt32LE(4);
  const jsonStrLen = head.readUInt32LE(12);
  if (jsonStrLen <= 0 || jsonStrLen > 64 * 1024 * 1024) throw new Error("asar header size out of range");
  const jsonBuf = Buffer.alloc(jsonStrLen);
  fs.readSync(fd, jsonBuf, 0, jsonStrLen, 16);
  const header = JSON.parse(jsonBuf.toString("utf8"));
  const base = 8 + headerPayloadSize;
  return { header, baseOffset: base % 4 ? base + 4 - (base % 4) : base };
}

// Reads Codex's bundled companion spritesheets out of the app's asar. Returns
// [{ id, displayName, description, spriteVersionNumber, buffer }]. Degrades to [] if
// Codex isn't installed or the bundle can't be read.
function readCodexBuiltinPets(asarPath = resolveCodexAsarPath()) {
  const resolvedAsarPath = path.resolve(asarPath);
  let asarStat;
  try { asarStat = fs.statSync(resolvedAsarPath); } catch { return []; }
  const cacheKey = `${resolvedAsarPath}:${asarStat.mtimeMs}:${asarStat.size}`;
  if (codexAsarCache?.key === cacheKey) return codexAsarCache.pets;

  let fd;
  try { fd = fs.openSync(resolvedAsarPath, "r"); } catch { return []; }
  try {
    const { header, baseOffset } = readAsarHeader(fd);
    const entries = [];
    (function walk(node) {
      for (const [name, value] of Object.entries(node?.files || {})) {
        if (value?.files) walk(value);
        else if (/-spritesheet-.*\.webp$/i.test(name) && value?.offset != null) entries.push([name, value]);
      }
    })(header);
    const byId = new Map();
    for (const [name, entry] of entries) {
      const id = name.replace(/-spritesheet-.*$/i, "").toLowerCase();
      if (!PET_ID_RE.test(id) || BUILTIN_IDS.has(id) || byId.has(id)) continue;
      const size = Number(entry.size);
      if (!(size > 0) || size > MAX_SPRITESHEET_BYTES) continue;
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, baseOffset + Number(entry.offset));
      let dimensions;
      try { dimensions = readWebpDimensions(buffer); } catch { continue; }
      const spriteVersionNumber = dimensions.width === 1536 && dimensions.height === 2288 ? 2
        : dimensions.width === 1536 && dimensions.height === 1872 ? 1 : 0;
      if (!spriteVersionNumber) continue;
      byId.set(id, {
        id,
        displayName: CODEX_BUILTIN_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1)),
        description: "Built-in Codex companion.",
        spriteVersionNumber,
        buffer,
      });
    }
    const pets = [...byId.values()];
    codexAsarCache = { key: cacheKey, pets };
    return pets;
  } catch {
    codexAsarCache = { key: cacheKey, pets: [] };
    return [];
  }
  finally { try { fs.closeSync(fd); } catch {} }
}

// Preview URL for an importable Codex pet (served before it lands in our own dir).
function codexAssetUrl(id, version) {
  return `/api/pets/codex/${encodeURIComponent(id)}/${PET_SPRITESHEET}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

// Lists Codex pets that could be imported but aren't in TokenTracker yet: valid
// packages in ~/.codex/pets plus Codex's app-bundled companions. Each carries an
// assetUrl so the picker can preview sprites.
function listCodexImportablePets() {
  const alreadyHere = new Set(listInstalledPets().map((pet) => pet.id));
  const result = new Map();
  const codexRoot = resolveCodexPetsDir();
  let names = [];
  try { names = fs.readdirSync(codexRoot); } catch { names = []; }
  for (const name of names) {
    if (!PET_ID_RE.test(name) || BUILTIN_IDS.has(name) || alreadyHere.has(name)) continue;
    try {
      const loaded = loadPetDirectory(path.join(codexRoot, name), name);
      result.set(name, {
        ...loaded.manifest,
        custom: true,
        assetUrl: codexAssetUrl(name, loaded.assetVersion),
        assetVersion: loaded.assetVersion,
        source: "codex-dir",
      });
    } catch {}
  }
  for (const pet of readCodexBuiltinPets()) {
    if (alreadyHere.has(pet.id) || result.has(pet.id)) continue;
    result.set(pet.id, {
      id: pet.id,
      displayName: pet.displayName,
      description: pet.description,
      spritesheetPath: PET_SPRITESHEET,
      spriteVersionNumber: pet.spriteVersionNumber,
      custom: true,
      assetUrl: codexAssetUrl(pet.id, `app${pet.spriteVersionNumber}`),
      source: "codex-app",
    });
  }
  return [...result.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Returns { buffer, contentLength } for an importable Codex pet's spritesheet — from
// ~/.codex/pets first, then the app bundle. Powers the picker preview route.
function readCodexImportableAsset(id) {
  const normalized = String(id || "").trim().toLowerCase();
  if (!PET_ID_RE.test(normalized) || BUILTIN_IDS.has(normalized)) return null;
  const codexDir = path.join(resolveCodexPetsDir(), normalized);
  try {
    const loaded = loadPetDirectory(codexDir, normalized);
    return { buffer: fs.readFileSync(loaded.spritesheetPath) };
  } catch {}
  for (const pet of readCodexBuiltinPets()) {
    if (pet.id === normalized) return { buffer: pet.buffer };
  }
  return null;
}

function importFromCodex(ids) {
  const requested = new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter((id) => PET_ID_RE.test(id) && !BUILTIN_IDS.has(id)),
  );
  if (requested.size === 0) throw new Error("No valid Codex pet ids to import");
  const root = resolvePetsDir();
  // The listing excludes already-installed ids, but enforce the same rule at
  // the write boundary so a handcrafted local API request cannot overwrite a
  // TokenTracker-owned pet with Codex's copy.
  for (const id of [...requested]) {
    if (fs.existsSync(path.join(root, id))) requested.delete(id);
  }
  if (requested.size === 0) throw new Error("Requested Codex pets are already installed");
  const codexRoot = resolveCodexPetsDir();
  const imported = [];
  for (const id of [...requested]) {
    try {
      const loaded = loadPetDirectory(path.join(codexRoot, id), id);
      const installed = writePetIntoDir(root, loaded.manifest, fs.readFileSync(loaded.spritesheetPath));
      imported.push(publicPet(loaded.manifest, { assetVersion: installed.assetVersion }));
      requested.delete(id);
    } catch {}
  }
  if (requested.size > 0) {
    for (const pet of readCodexBuiltinPets()) {
      if (!requested.has(pet.id)) continue;
      const manifest = normalizeManifest({
        id: pet.id,
        displayName: pet.displayName,
        description: pet.description,
        spritesheetPath: PET_SPRITESHEET,
        ...(pet.spriteVersionNumber === 2 ? { spriteVersionNumber: 2 } : {}),
      });
      try {
        const installed = writePetIntoDir(root, manifest, pet.buffer);
        imported.push(publicPet(manifest, { assetVersion: installed.assetVersion }));
        requested.delete(pet.id);
      } catch {}
    }
  }
  if (imported.length === 0) throw new Error("None of the requested Codex pets could be imported");
  return { imported };
}

module.exports = {
  MAX_PACKAGE_BYTES,
  importFromCodex,
  importPetZip,
  installFromCodexPets,
  listCodexImportablePets,
  listInstalledPets,
  migrateLegacyCodexPets,
  normalizeManifest,
  petIdFromCodexPetsUrl,
  readCodexBuiltinPets,
  readCodexImportableAsset,
  readWebpDimensions,
  removeInstalledPet,
  resolveCodexPetsDir,
  resolvePetAsset,
  resolvePetsDir,
  validatePackageFiles,
};
