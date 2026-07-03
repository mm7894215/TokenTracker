const wsl = require("./wsl-probe");
const { ensureNamespacedCursors } = require("./install-resolver");

const ISSUE_URL = "https://github.com/mm7894215/TokenTracker/issues";

function emptyResult() {
  return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
}

async function multiInstallParse({ paths, parserFn, providerName, cursors, getParams, onProgress, ...shared }) {
  const installKeys = Object.keys(paths).filter(k => paths[k]);
  if (installKeys.length === 0) return emptyResult();
  const env = shared.env || process.env;

  if (installKeys.length === 1) {
    return await parserFn({
      ...getParams(paths[installKeys[0]], installKeys[0]),
      ...shared,
      cursors,
      onProgress,
    });
  }

  const prefer = wsl.getWslPrefer(env);
  const ns = ensureNamespacedCursors(cursors, providerName);
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  let bucketsQueued = 0;

  if (prefer) {
    // Conflict resolution mode: parse preferred install first, snapshot, then
    // parse second. Restore snapshot for any overlapping bucket.
    const firstKey = prefer === "wsl" ? "wsl" : "native";
    const secondKey = prefer === "wsl" ? "native" : "wsl";

    cursors[providerName] = ns[firstKey];
    const firstResult = await parserFn({
      ...getParams(paths[firstKey], firstKey), ...shared, cursors,
      onProgress: wrapProgress(onProgress, firstKey),
    });
    ns[firstKey] = cursors[providerName];
    recordsProcessed += firstResult.recordsProcessed || 0;
    eventsAggregated += firstResult.eventsAggregated || 0;
    bucketsQueued += firstResult.bucketsQueued || 0;

    const preferredBuckets = snapshotBuckets(cursors.hourly);

    cursors[providerName] = ns[secondKey];
    let secondResult;
    try {
      secondResult = await parserFn({
        ...getParams(paths[secondKey], secondKey), ...shared, cursors,
        onProgress: wrapProgress(onProgress, secondKey),
      });
    } catch (parseErr) {
      cursors[providerName] = ns;
      throw parseErr;
    }
    ns[secondKey] = cursors[providerName];
    recordsProcessed += secondResult.recordsProcessed || 0;
    eventsAggregated += secondResult.eventsAggregated || 0;
    bucketsQueued += secondResult.bucketsQueued || 0;

    // Restore preferred install's data for overlapping buckets
    const conflicts = [];
    if (cursors.hourly?.buckets) {
      for (const key of Object.keys(preferredBuckets)) {
        if (cursors.hourly.buckets[key]) {
          conflicts.push(key);
          cursors.hourly.buckets[key] = preferredBuckets[key];
        }
      }
    }

    cursors[providerName] = ns;

    if (conflicts.length > 0) {
      console.warn(
        `[tokentracker] ${providerName}: ${conflicts.length} bucket(s) had data from both installs — ` +
        `using ${firstKey} (TOKENTRACKER_WSL_PREFER=${prefer}), discarded ${secondKey} contributions. ` +
        `Buckets: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ` +${conflicts.length - 5} more` : ""}. ` +
        `Report unexpected behavior at ${ISSUE_URL}`
      );
    }
  } else {
    // No preference: parse both installs and keep all data.
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
  }

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

function snapshotBuckets(hourly) {
  if (!hourly?.buckets) return {};
  const out = {};
  for (const [key, val] of Object.entries(hourly.buckets)) {
    out[key] = JSON.parse(JSON.stringify(val));
  }
  return out;
}

function wrapProgress(onProgress, installKey) {
  if (!onProgress) return undefined;
  return (p) => onProgress({ ...p, install: installKey });
}

function mergeBothFileSources({ resolveFiles, env }) {
  const files = resolveFiles(env);
  if (files.length === 0) return files;
  if (process.platform !== "win32" || wsl.getWslMode(env) !== "both") return files;

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
