const fssync = require("node:fs");
const path = require("node:path");
const wsl = require("./wsl-probe");

function resolveInstallPaths({ nativeValue, wslDir, wslValue, requireAnyChild } = {}, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== "win32") {
    return { native: nativeValue ?? null, wsl: null };
  }

  // requireAnyChild (opt-in): a candidate install must hold at least one of
  // the named children (e.g. "sessions"/"archived_sessions") to qualify — an
  // empty shell dir must not shadow a populated install. For wslDir discovery
  // the check is folded into the existsSync probe so discoverWslHome skips an
  // empty-shell distro and continues to the next one.
  const populated = (p) => !requireAnyChild || hasAnyChild(p, requireAnyChild, deps.existsSync);
  const wslExists = requireAnyChild
    ? (p) => Boolean(pathExists(p, deps.existsSync)) && hasAnyChild(p, requireAnyChild, deps.existsSync)
    : deps.existsSync;
  const wslCandidate = wslValue !== undefined
    ? (wsl.shouldProbeWsl(env) && pathExists(wslValue, deps.existsSync) && populated(wslValue) ? wslValue : null)
    : (wslDir && wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(wslDir, { ...deps, env, existsSync: wslExists }) : null);
  const nativeCandidate = wsl.shouldProbeNative(env) && nativeValue && populated(nativeValue)
    ? pathExists(nativeValue, deps.existsSync) : null;

  return wsl.resolveAllWin32Paths({ nativeValue: nativeCandidate, wslValue: wslCandidate, env, platform });
}

function pathExists(p, existsSync) {
  if (typeof p !== "string" || !p) return null;
  try { return (existsSync || fssync.existsSync)(p) ? p : null; } catch (_e) { return null; }
}

function hasAnyChild(p, children, existsSync) {
  const ex = existsSync || fssync.existsSync;
  return children.some((c) => { try { return ex(path.join(p, c)); } catch (_e) { return false; } });
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

// Collapse { native, wsl } namespaces back into a flat cursor when only one
// install remains. `preferredKey` names the SURVIVING install's namespace —
// its keys must win the merge, otherwise the vanished install's cursor
// (lastDbId watermarks, dedup maps) is donated to the survivor and its next
// parse double-counts everything past the foreign cursor. Callers that don't
// know the survivor fall back to the mode preference (legacy behavior).
function ensureFlatCursor(cursors, providerName, env, preferredKey) {
  const state = cursors[providerName];
  if (!state || typeof state !== "object") return;
  if (state.native === undefined && state.wsl === undefined) return;

  const mode = wsl.getWslMode(env || process.env);
  const preferWsl = preferredKey === "wsl" || preferredKey === "native"
    ? preferredKey === "wsl"
    : mode === "wsl-first" || mode === "wsl-only";
  const merged = preferWsl ? { ...state.native, ...state.wsl } : { ...state.wsl, ...state.native };
  cursors[providerName] = merged;
}

module.exports = {
  resolveInstallPaths,
  ensureNamespacedCursors,
  ensureFlatCursor,
};
