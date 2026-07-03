const fssync = require("node:fs");
const wsl = require("./wsl-probe");

function resolveInstallPaths(providerName, { nativeValue, wslDir, wslValue } = {}, env = process.env, deps = {}) {
  if (process.platform !== "win32") {
    return { native: nativeValue ?? null, wsl: null };
  }

  const wslCandidate = wslValue !== undefined
    ? (wsl.shouldProbeWsl(env) ? wslValue : null)
    : (wslDir && wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(wslDir, { ...deps, env }) : null);
  const nativeCandidate = wsl.shouldProbeNative(env) && nativeValue
    ? pathExists(nativeValue) : null;

  if (wsl.getWslMode(env) === "both") {
    return { native: nativeCandidate, wsl: wslCandidate };
  }

  const single = wsl.pickWin32Path({ wslValue: wslCandidate, nativeValue: nativeCandidate, env, platform: "win32" });
  return { native: single, wsl: null };
}

function pathExists(p) {
  try { return fssync.existsSync(p) ? p : null; } catch (_e) { return null; }
}

function ensureNamespacedCursors(cursors, providerName) {
  const state = cursors[providerName] && typeof cursors[providerName] === "object" ? cursors[providerName] : {};

  if (state.native !== undefined || state.wsl !== undefined) {
    return state;
  }

  const flat = { ...state };
  cursors[providerName] = { native: { ...flat }, wsl: { ...flat } };
  return cursors[providerName];
}

function ensureFlatCursor(cursors, providerName) {
  const state = cursors[providerName];
  if (!state || typeof state !== "object") return;
  if (state.native === undefined && state.wsl === undefined) return;

  const merged = { ...state.wsl, ...state.native };
  cursors[providerName] = merged;
}

module.exports = {
  resolveInstallPaths,
  ensureNamespacedCursors,
  ensureFlatCursor,
};
