const wsl = require("./wsl-probe");
const { ensureNamespacedCursors, ensureFlatCursor } = require("./install-resolver");

function emptyResult() {
  return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
}

async function multiInstallParse({ paths, parserFn, providerName, cursors, getParams, onProgress, ...shared }) {
  const installKeys = Object.keys(paths).filter(k => paths[k]);
  if (installKeys.length === 0) return emptyResult();
  const env = shared.env || process.env;

  if (installKeys.length === 1) {
    ensureFlatCursor(cursors, providerName, env);
    return await parserFn({
      ...getParams(paths[installKeys[0]], installKeys[0]),
      ...shared,
      cursors,
      onProgress,
    });
  }

  const ns = ensureNamespacedCursors(cursors, providerName);
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  let bucketsQueued = 0;

  for (let i = 0; i < installKeys.length; i++) {
    const key = installKeys[i];
    cursors[providerName] = ns[key];
    try {
      const result = await parserFn({
        ...getParams(paths[key], key), ...shared, cursors,
        onProgress: wrapProgress(onProgress, key),
      });
      ns[key] = cursors[providerName];
      recordsProcessed += result.recordsProcessed || 0;
      eventsAggregated += result.eventsAggregated || 0;
      bucketsQueued += result.bucketsQueued || 0;
    } catch (parseErr) {
      cursors[providerName] = ns;
      throw parseErr;
    }
  }
  cursors[providerName] = ns;

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

function wrapProgress(onProgress, installKey) {
  if (!onProgress) return undefined;
  return (p) => onProgress({ ...p, install: installKey });
}

function mergeBothFileSources({ resolveFiles, env }) {
  const isBoth = process.platform === "win32" && wsl.getWslMode(env) === "both";
  if (!isBoth) {
    const files = resolveFiles(env);
    return files;
  }

  const nativeEnv = { ...env, TOKENTRACKER_WSL_MODE: "native-only" };
  const wslEnv = { ...env, TOKENTRACKER_WSL_MODE: "wsl-only" };

  const nativeFiles = resolveFiles(nativeEnv);
  const wslFiles = resolveFiles(wslEnv);

  const seen = new Set();
  const merged = [];
  for (const f of [...nativeFiles, ...wslFiles]) {
    if (!seen.has(f)) { seen.add(f); merged.push(f); }
  }
  return merged;
}

module.exports = { multiInstallParse, emptyResult, mergeBothFileSources };
