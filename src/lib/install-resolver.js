const fssync = require("node:fs");
const wsl = require("./wsl-probe");

function resolveInstallPaths({ nativeValue, wslDir, wslValue } = {}, env = process.env, deps = {}) {
  if (process.platform !== "win32") {
    return { native: nativeValue ?? null, wsl: null };
  }

  const wslCandidate = wslValue !== undefined
    ? (wsl.shouldProbeWsl(env) && pathExists(wslValue, deps.existsSync) ? wslValue : null)
    : (wslDir && wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(wslDir, { ...deps, env }) : null);
  const nativeCandidate = wsl.shouldProbeNative(env) && nativeValue
    ? pathExists(nativeValue, deps.existsSync) : null;

  return wsl.resolveAllWin32Paths({ nativeValue: nativeCandidate, wslValue: wslCandidate, env, platform: "win32" });
}

function pathExists(p, existsSync) {
  try { return (existsSync || fssync.existsSync)(p) ? p : null; } catch (_e) { return null; }
}

// Migrate a flat (single-install) cursor to { native, wsl } namespaces.
// `activeKeys` names the namespaces seeded with a copy of the flat state; the
// others start empty so their install's full history backfills on first parse.
// Leaving a namespace empty is only safe when its install was NEVER counted
// under the flat cursor — the flat state holds the per-session dedup maps, and
// an already-counted install re-parsed without them double-counts everything.
// Callers that cannot prove which install the flat cursor tracked must seed
// ALL namespaces (the default): bounded backfill loss, never a double count.
function ensureNamespacedCursors(cursors, providerName, activeKeys = ["native", "wsl"]) {
  const state = cursors[providerName] && typeof cursors[providerName] === "object" ? cursors[providerName] : {};

  if (state.native !== undefined || state.wsl !== undefined) {
    return state;
  }

  const keys = Array.isArray(activeKeys) ? activeKeys : [activeKeys];
  cursors[providerName] = { native: {}, wsl: {} };
  if (Object.keys(state).length > 0) {
    for (const key of keys) {
      cursors[providerName][key] = JSON.parse(JSON.stringify(state));
    }
  }
  return cursors[providerName];
}

function ensureFlatCursor(cursors, providerName, env) {
  const state = cursors[providerName];
  if (!state || typeof state !== "object") return;
  if (state.native === undefined && state.wsl === undefined) return;

  const mode = wsl.getWslMode(env || process.env);
  const preferWsl = mode === "wsl-first" || mode === "wsl-only";
  const merged = preferWsl ? { ...state.native, ...state.wsl } : { ...state.wsl, ...state.native };
  cursors[providerName] = merged;
}

module.exports = {
  resolveInstallPaths,
  ensureNamespacedCursors,
  ensureFlatCursor,
};
