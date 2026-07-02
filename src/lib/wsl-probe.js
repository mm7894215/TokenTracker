const fssync = require("node:fs");
const path = require("node:path");

const DEFAULT_EXEC_OPTS = { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };

let _cachedDistros = null;

function resetWslProbeCache() {
  _cachedDistros = null;
}

const WSL_MODES = new Set([
  "wsl-first",
  "native-first",
  "wsl-only",
  "native-only",
]);

function defaultRunWsl(args, { utf16 = false } = {}) {
  const { execFileSync } = require("node:child_process");
  const buf = execFileSync("wsl.exe", args, DEFAULT_EXEC_OPTS);
  return utf16 ? buf.toString("utf16le") : buf.toString("utf8");
}

function parseWslListVerbose(raw) {
  if (typeof raw !== "string") return [];
  const distros = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(/\0/g, "").replace(/\uFEFF/g, "").trim();
    if (!clean) continue;
    const cells = clean.split(/\s+/);
    let isDefault = false;
    let idx = 0;
    if (cells[0] === "*") {
      isDefault = true;
      idx = 1;
    }
    const name = cells[idx];
    if (!name || name === "NAME") continue;
    const version = parseInt(cells[cells.length - 1], 10);
    distros.push({ name, version: Number.isFinite(version) ? version : null, isDefault });
  }
  return distros;
}

function probeWslDistros(deps = {}) {
  const hasDeps = Object.keys(deps).length > 0;
  if (!hasDeps && _cachedDistros) return _cachedDistros;
  const runWsl = deps.runWsl || defaultRunWsl;
  let raw;
  try {
    raw = runWsl(["-l", "-v"], { utf16: true });
  } catch (_e) {
    return [];
  }
  const distros = parseWslListVerbose(raw);
  const sorted = distros.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  if (!hasDeps) _cachedDistros = sorted;
  return sorted;
}

function normalizeWslMode(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function getWslMode(env = process.env) {
  const raw = normalizeWslMode(env.TOKENTRACKER_WSL_MODE);
  return WSL_MODES.has(raw) ? raw : "wsl-first";
}

function isInvalidWslMode(env = process.env) {
  const value = env.TOKENTRACKER_WSL_MODE;
  if (value == null || String(value).trim() === "") return false;
  return !WSL_MODES.has(normalizeWslMode(value));
}

function shouldProbeWsl(env = process.env) {
  return getWslMode(env) !== "native-only";
}

function shouldProbeNative(env = process.env) {
  return getWslMode(env) !== "wsl-only";
}

function pickWin32Path({
  wslValue,
  nativeValue,
  env = process.env,
  platform = process.platform,
}) {
  if (platform !== "win32") return null;

  const mode = getWslMode(env);

  if (mode === "wsl-only") return wslValue ?? null;
  if (mode === "native-only") return nativeValue ?? null;
  if (mode === "native-first") return nativeValue ?? wslValue ?? null;

  return wslValue ?? nativeValue ?? null;
}

function discoverWslHome(providerDir, deps = {}) {
  if (!shouldProbeWsl(deps.env)) return null;

  const runWsl = deps.runWsl || defaultRunWsl;
  const existsSync = deps.existsSync || fssync.existsSync;
  const distros = deps.runWsl ? probeWslDistros({ runWsl: deps.runWsl }) : probeWslDistros();
  for (const distro of distros) {
    let user;
    try {
      user = String(runWsl(["-d", distro.name, "-e", "whoami"], { utf16: false }) || "").trim();
    } catch (_e) {
      user = "";
    }
    if (!user) continue;
    const roots = distro.version === 1
      ? ["\\\\wsl.localhost\\", "\\\\wsl$\\"]
      : ["\\\\wsl$\\", "\\\\wsl.localhost\\"];
    for (const root of roots) {
      const candidate = `${root}${distro.name}\\home\\${user}\\${providerDir}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch (_e) { }
    }
  }
  return null;
}

function isUncPath(p) {
  return typeof p === "string" && (p.startsWith("\\\\") || p.startsWith("//"));
}

function snapshotSqliteDb(dbPath) {
  const tmpRoot = fssync.mkdtempSync(
    path.join(require("node:os").tmpdir(), "tokentracker-wsl-snap-"),
  );
  const target = path.join(tmpRoot, path.basename(dbPath));
  fssync.copyFileSync(dbPath, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const src = dbPath + suffix;
    try {
      if (fssync.existsSync(src)) fssync.copyFileSync(src, target + suffix);
    } catch (_e) { }
  }
  return {
    path: target,
    cleanup() {
      try { fssync.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { }
    },
  };
}

module.exports = {
  defaultRunWsl,
  parseWslListVerbose,
  probeWslDistros,
  resetWslProbeCache,
  discoverWslHome,
  isUncPath,
  snapshotSqliteDb,
  getWslMode,
  isInvalidWslMode,
  shouldProbeWsl,
  shouldProbeNative,
  pickWin32Path,
  normalizeWslMode,
};
