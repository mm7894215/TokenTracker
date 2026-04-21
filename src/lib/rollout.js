const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const cp = require("node:child_process");

const crypto = require("node:crypto");
const { ensureDir } = require("./fs");

const DEFAULT_SOURCE = "codex";
const DEFAULT_MODEL = "unknown";
const BUCKET_SEPARATOR = "|";

async function listRolloutFiles(sessionsDir) {
  const out = [];
  const years = await safeReadDir(sessionsDir);
  for (const y of years) {
    if (!/^[0-9]{4}$/.test(y.name) || !y.isDirectory()) continue;
    const yearDir = path.join(sessionsDir, y.name);
    const months = await safeReadDir(yearDir);
    for (const m of months) {
      if (!/^[0-9]{2}$/.test(m.name) || !m.isDirectory()) continue;
      const monthDir = path.join(yearDir, m.name);
      const days = await safeReadDir(monthDir);
      for (const d of days) {
        if (!/^[0-9]{2}$/.test(d.name) || !d.isDirectory()) continue;
        const dayDir = path.join(monthDir, d.name);
        const files = await safeReadDir(dayDir);
        for (const f of files) {
          if (!f.isFile()) continue;
          if (!f.name.startsWith("rollout-") || !f.name.endsWith(".jsonl")) continue;
          out.push(path.join(dayDir, f.name));
        }
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listClaudeProjectFiles(projectsDir) {
  const out = [];
  await walkClaudeProjects(projectsDir, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listGeminiSessionFiles(tmpDir) {
  const out = [];
  const roots = await safeReadDir(tmpDir);
  for (const root of roots) {
    if (!root.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, root.name, "chats");
    const chats = await safeReadDir(chatsDir);
    for (const entry of chats) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
      out.push(path.join(chatsDir, entry.name));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listOpencodeMessageFiles(storageDir) {
  const out = [];
  const messageDir = path.join(storageDir, "message");
  await walkOpencodeMessages(messageDir, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function parseRolloutIncremental({
  rolloutFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const totalFiles = Array.isArray(rolloutFiles) ? rolloutFiles.length : 0;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || DEFAULT_SOURCE;

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < rolloutFiles.length; idx++) {
    const entry = rolloutFiles[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const startOffset = prev && prev.inode === inode ? prev.offset || 0 : 0;
    const lastTotal = prev && prev.inode === inode ? prev.lastTotal || null : null;
    const lastModel = prev && prev.inode === inode ? prev.lastModel || null : null;

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseRolloutFile({
      filePath,
      startOffset,
      lastTotal,
      lastModel,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
      projectMetaCache,
      publicRepoCache,
      publicRepoResolver,
    });

    cursors.files[key] = {
      inode,
      offset: result.endOffset,
      lastTotal: result.lastTotal,
      lastModel: result.lastModel,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseClaudeIncremental({
  projectFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(projectFiles) ? projectFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  // Persist seenMessageHashes across syncs to prevent cross-file duplicates
  // (e.g. subagent file created after main session was already parsed).
  const prevHashes = Array.isArray(cursors.claudeHashes) ? cursors.claudeHashes : [];
  const seenMessageHashes = new Set(prevHashes);
  const defaultSource = normalizeSourceInput(source) || "claude";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const startOffset = prev && prev.inode === inode ? prev.offset || 0 : 0;

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseClaudeFile({
      filePath,
      startOffset,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
      seenMessageHashes,
    });

    cursors.files[key] = {
      inode,
      offset: result.endOffset,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }
  // Persist message hashes for cross-sync dedup; cap at 100k entries to bound size.
  const allHashes = Array.from(seenMessageHashes);
  cursors.claudeHashes =
    allHashes.length > 100_000 ? allHashes.slice(allHashes.length - 100_000) : allHashes;

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseGeminiIncremental({
  sessionFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "gemini";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    let startIndex = prev && prev.inode === inode ? Number(prev.lastIndex || -1) : -1;
    let lastTotals = prev && prev.inode === inode ? prev.lastTotals || null : null;
    let lastModel = prev && prev.inode === inode ? prev.lastModel || null : null;

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseGeminiFile({
      filePath,
      startIndex,
      lastTotals,
      lastModel,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
    });

    cursors.files[key] = {
      inode,
      lastIndex: result.lastIndex,
      lastTotals: result.lastTotals,
      lastModel: result.lastModel,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseOpencodeIncremental({
  messageFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(messageFiles) ? messageFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const opencodeState = normalizeOpencodeState(cursors?.opencode);
  const messageIndex = opencodeState.messages;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "opencode";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const size = Number.isFinite(st.size) ? st.size : 0;
    const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
    const unchanged =
      prev && prev.inode === inode && prev.size === size && prev.mtimeMs === mtimeMs;
    if (unchanged) {
      filesProcessed += 1;
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    const fallbackTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;
    const fallbackMessageKey =
      prev && typeof prev.messageKey === "string" && prev.messageKey.trim()
        ? prev.messageKey.trim()
        : null;
    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseOpencodeMessageFile({
      filePath,
      messageIndex,
      fallbackTotals,
      fallbackMessageKey,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
    });

    cursors.files[key] = {
      inode,
      size,
      mtimeMs,
      lastTotals: result.lastTotals,
      messageKey: result.messageKey || null,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (result.messageKey && result.shouldUpdate) {
      messageIndex[result.messageKey] = {
        lastTotals: result.lastTotals,
        updatedAt: new Date().toISOString(),
      };
    }

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  opencodeState.updatedAt = new Date().toISOString();
  cursors.opencode = opencodeState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseOpenclawIncremental({
  sessionFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "openclaw";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const startOffset = prev && prev.inode === inode ? prev.offset || 0 : 0;

    const result = await parseOpenclawSessionFile({
      filePath,
      startOffset,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
    });

    cursors.files[key] = {
      inode,
      offset: result.endOffset,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseOpenclawSessionFile({
  filePath,
  startOffset,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
}) {
  const st = await fs.stat(filePath);
  const endOffset = st.size;
  if (startOffset >= endOffset) return { endOffset, eventsAggregated: 0 };

  const stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let eventsAggregated = 0;
  for await (const line of rl) {
    if (!line) continue;
    // Fast-path filter: OpenClaw assistant messages include message.usage.totalTokens.
    if (!line.includes('"usage"') || !line.includes("totalTokens")) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    if (obj?.type !== "message") continue;
    const msg = obj?.message;
    if (!msg || typeof msg !== "object") continue;

    const usage = msg.usage;
    if (!usage || typeof usage !== "object") continue;

    const tokenTimestamp = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!tokenTimestamp) continue;

    const model = normalizeModelInput(msg.model) || DEFAULT_MODEL;

    // Per CLAUDE.md: cached_input_tokens = cache reads,
    // cache_creation_input_tokens = cache writes. Also re-derive total_tokens
    // as input + output + cache_creation + cache_read so cost math works
    // even when the source's own totalTokens is stale or rounded.
    const inputTok = Number(usage.input || 0);
    const cacheReadTok = Number(usage.cacheRead || 0);
    const cacheWriteTok = Number(usage.cacheWrite || 0);
    const outputTok = Number(usage.output || 0);
    const delta = {
      input_tokens: inputTok,
      cached_input_tokens: cacheReadTok,
      cache_creation_input_tokens: cacheWriteTok,
      output_tokens: outputTok,
      reasoning_output_tokens: 0,
      total_tokens: inputTok + outputTok + cacheReadTok + cacheWriteTok,
      conversation_count: 1,
    };

    if (isAllZeroUsage(delta)) continue;

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));

    // Project-level OpenClaw attribution is not supported yet (no stable cwd info).
    // If OpenClaw later records cwd per event, we can mirror rollout's project logic.
    eventsAggregated += 1;
  }

  rl.close();
  stream.close?.();
  return { endOffset, eventsAggregated };
}

async function parseRolloutFile({
  filePath,
  startOffset,
  lastTotal,
  lastModel,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
}) {
  const st = await fs.stat(filePath);
  const endOffset = st.size;
  if (startOffset >= endOffset) {
    return { endOffset, lastTotal, lastModel, eventsAggregated: 0 };
  }

  const stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let model = typeof lastModel === "string" ? lastModel : null;
  let totals = lastTotal && typeof lastTotal === "object" ? lastTotal : null;
  let currentCwd = null;
  let currentProjectRef = projectRef || null;
  let currentProjectKey = projectKey || null;
  let eventsAggregated = 0;

  for await (const line of rl) {
    if (!line) continue;
    const maybeTokenCount = line.includes('"token_count"');
    const maybeTurnContext =
      !maybeTokenCount &&
      (line.includes('"turn_context"') || line.includes('"session_meta"')) &&
      (line.includes('"model"') || line.includes('"cwd"'));
    if (!maybeTokenCount && !maybeTurnContext) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    if (
      (obj?.type === "turn_context" || obj?.type === "session_meta") &&
      obj?.payload &&
      typeof obj.payload === "object"
    ) {
      if (typeof obj.payload.model === "string") {
        model = obj.payload.model;
      }
      if (projectState && typeof obj.payload.cwd === "string") {
        const nextCwd = obj.payload.cwd.trim();
        if (nextCwd && nextCwd !== currentCwd) {
          const context = await resolveProjectContextForPath({
            startDir: nextCwd,
            projectMetaCache,
            publicRepoCache,
            publicRepoResolver,
            projectState,
          });
          currentCwd = nextCwd;
          currentProjectRef = context?.projectRef || null;
          currentProjectKey = context?.projectKey || null;
        }
      }
      continue;
    }

    const token = extractTokenCount(obj);
    if (!token) continue;

    const info = token.info;
    if (!info || typeof info !== "object") continue;

    const tokenTimestamp = typeof token.timestamp === "string" ? token.timestamp : null;
    if (!tokenTimestamp) continue;

    const lastUsage = info.last_token_usage;
    const totalUsage = info.total_token_usage;

    const delta = pickDelta(lastUsage, totalUsage, totals);
    if (!delta) continue;
    delta.conversation_count = 1;

    if (totalUsage && typeof totalUsage === "object") {
      totals = totalUsage;
    }

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));
    if (currentProjectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        currentProjectKey,
        source,
        bucketStart,
        currentProjectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(currentProjectKey, source, bucketStart));
    }
    eventsAggregated += 1;
  }

  return { endOffset, lastTotal: totals, lastModel: model, eventsAggregated };
}

async function parseClaudeFile({
  filePath,
  startOffset,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
  seenMessageHashes,
}) {
  const st = await fs.stat(filePath).catch(() => null);
  if (!st || !st.isFile()) return { endOffset: startOffset, eventsAggregated: 0 };

  const endOffset = st.size;
  if (startOffset >= endOffset) return { endOffset, eventsAggregated: 0 };

  const stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let eventsAggregated = 0;
  const isMainSession = !filePath.includes("/subagents/");
  for await (const line of rl) {
    if (!line) continue;

    // Count user-typed messages as conversations (main sessions only).
    // Exclude tool_result messages — those are auto-generated by tool calls,
    // not manually typed by the user. Only count messages with a "text" block.
    if (isMainSession && line.includes('"type":"user"')) {
      let userObj;
      try {
        userObj = JSON.parse(line);
      } catch (_e) {
        /* skip */
      }
      if (userObj?.type === "user") {
        const content = userObj?.message?.content;
        const hasText =
          typeof content === "string" ||
          (Array.isArray(content) && content.some((b) => b?.type === "text"));
        if (hasText) {
          const userTs = typeof userObj?.timestamp === "string" ? userObj.timestamp : null;
          const userBucketStart = userTs ? toUtcHalfHourStart(userTs) : null;
          if (userBucketStart) {
            const userModel = DEFAULT_MODEL;
            const userBucket = getHourlyBucket(hourlyState, source, userModel, userBucketStart);
            userBucket.totals.conversation_count += 1;
            touchedBuckets.add(bucketKey(source, userModel, userBucketStart));
          }
        }
      }
    }

    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    const usage = obj?.message?.usage || obj?.usage;
    if (!usage || typeof usage !== "object") continue;

    if (seenMessageHashes) {
      const msgId = obj?.message?.id;
      const reqId = obj?.requestId;
      if (msgId && reqId) {
        const hash = `${msgId}:${reqId}`;
        if (seenMessageHashes.has(hash)) continue;
        seenMessageHashes.add(hash);
      }
    }

    const model = normalizeModelInput(obj?.message?.model || obj?.model) || DEFAULT_MODEL;
    const tokenTimestamp = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!tokenTimestamp) continue;

    const delta = normalizeClaudeUsage(usage);
    if (!delta || isAllZeroUsage(delta)) continue;
    delta.conversation_count = 0;

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));
    if (projectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        projectKey,
        source,
        bucketStart,
        projectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
    }
    eventsAggregated += 1;
  }

  rl.close();
  stream.close?.();
  return { endOffset, eventsAggregated };
}

async function parseGeminiFile({
  filePath,
  startIndex,
  lastTotals,
  lastModel,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return { lastIndex: startIndex, lastTotals, lastModel, eventsAggregated: 0 };

  let session;
  try {
    session = JSON.parse(raw);
  } catch (_e) {
    return { lastIndex: startIndex, lastTotals, lastModel, eventsAggregated: 0 };
  }

  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (startIndex >= messages.length) {
    startIndex = -1;
    lastTotals = null;
    lastModel = null;
  }

  let eventsAggregated = 0;
  let model = typeof lastModel === "string" ? lastModel : null;
  let totals = lastTotals && typeof lastTotals === "object" ? lastTotals : null;
  const begin = Number.isFinite(startIndex) ? startIndex + 1 : 0;

  for (let idx = begin; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg || typeof msg !== "object") continue;

    const normalizedModel = normalizeModelInput(msg.model);
    if (normalizedModel) model = normalizedModel;

    const timestamp = typeof msg.timestamp === "string" ? msg.timestamp : null;
    const currentTotals = normalizeGeminiTokens(msg.tokens);
    if (!timestamp || !currentTotals) {
      totals = currentTotals || totals;
      continue;
    }

    const delta = diffGeminiTotals(currentTotals, totals);
    if (!delta || isAllZeroUsage(delta)) {
      totals = currentTotals;
      continue;
    }
    delta.conversation_count = 1;

    const bucketStart = toUtcHalfHourStart(timestamp);
    if (!bucketStart) {
      totals = currentTotals;
      continue;
    }

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));
    if (projectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        projectKey,
        source,
        bucketStart,
        projectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
    }
    eventsAggregated += 1;
    totals = currentTotals;
  }

  return {
    lastIndex: messages.length - 1,
    lastTotals: totals,
    lastModel: model,
    eventsAggregated,
  };
}

async function parseOpencodeMessageFile({
  filePath,
  messageIndex,
  fallbackTotals,
  fallbackMessageKey,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const fallbackKey =
    typeof fallbackMessageKey === "string" && fallbackMessageKey.trim()
      ? fallbackMessageKey.trim()
      : null;
  const legacyTotals = fallbackTotals && typeof fallbackTotals === "object" ? fallbackTotals : null;
  const fallbackEntry = messageIndex && fallbackKey ? messageIndex[fallbackKey] : null;
  const fallbackLastTotals =
    fallbackEntry && typeof fallbackEntry.lastTotals === "object"
      ? fallbackEntry.lastTotals
      : legacyTotals;

  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {
      messageKey: fallbackKey,
      lastTotals: fallbackLastTotals,
      eventsAggregated: 0,
      shouldUpdate: false,
    };
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_e) {
    return {
      messageKey: fallbackKey,
      lastTotals: fallbackLastTotals,
      eventsAggregated: 0,
      shouldUpdate: false,
    };
  }

  const messageKey = deriveOpencodeMessageKey(msg, filePath);
  const prev = messageIndex && messageKey ? messageIndex[messageKey] : null;
  const indexTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;
  const fallbackMatch = !fallbackKey || fallbackKey === messageKey;
  const lastTotals = indexTotals || (fallbackMatch ? fallbackLastTotals : null);

  const currentTotals = normalizeOpencodeTokens(msg?.tokens);
  if (!currentTotals) {
    return { messageKey, lastTotals, eventsAggregated: 0, shouldUpdate: false };
  }

  const delta = diffGeminiTotals(currentTotals, lastTotals);
  if (!delta || isAllZeroUsage(delta)) {
    return { messageKey, lastTotals: currentTotals, eventsAggregated: 0, shouldUpdate: true };
  }
  delta.conversation_count = 1;

  const timestampMs = coerceEpochMs(msg?.time?.completed) || coerceEpochMs(msg?.time?.created);
  if (!timestampMs) {
    return {
      messageKey,
      lastTotals,
      eventsAggregated: 0,
      shouldUpdate: Boolean(lastTotals),
    };
  }

  const tsIso = new Date(timestampMs).toISOString();
  const bucketStart = toUtcHalfHourStart(tsIso);
  if (!bucketStart) {
    return {
      messageKey,
      lastTotals,
      eventsAggregated: 0,
      shouldUpdate: Boolean(lastTotals),
    };
  }

  const model = normalizeModelInput(msg?.modelID || msg?.model || msg?.modelId) || DEFAULT_MODEL;
  const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
  addTotals(bucket.totals, delta);
  touchedBuckets.add(bucketKey(source, model, bucketStart));
  if (projectKey && projectState && projectTouchedBuckets) {
    const projectBucket = getProjectBucket(
      projectState,
      projectKey,
      source,
      bucketStart,
      projectRef,
    );
    addTotals(projectBucket.totals, delta);
    projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
  }
  return { messageKey, lastTotals: currentTotals, eventsAggregated: 1, shouldUpdate: true };
}

async function enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets }) {
  if (!touchedBuckets || touchedBuckets.size === 0) return 0;

  const touchedGroups = new Set();
  for (const bucketStart of touchedBuckets) {
    const parsed = parseBucketKey(bucketStart);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    touchedGroups.add(groupBucketKey(parsed.source, hourStart));
  }
  if (touchedGroups.size === 0) return 0;

  const groupQueued =
    hourlyState.groupQueued && typeof hourlyState.groupQueued === "object"
      ? hourlyState.groupQueued
      : {};
  let codexTouched = false;
  const legacyGroups = new Set();
  for (const groupKey of touchedGroups) {
    if (Object.prototype.hasOwnProperty.call(groupQueued, groupKey)) {
      legacyGroups.add(groupKey);
    }
    if (!codexTouched && groupKey.startsWith(`${DEFAULT_SOURCE}${BUCKET_SEPARATOR}`)) {
      codexTouched = true;
    }
  }

  const groupedBuckets = new Map();
  for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
    if (!bucket || !bucket.totals) continue;
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const groupKey = groupBucketKey(parsed.source, hourStart);
    if (!touchedGroups.has(groupKey) || legacyGroups.has(groupKey)) continue;

    const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
    const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
    let group = groupedBuckets.get(groupKey);
    if (!group) {
      group = { source, hourStart, buckets: new Map() };
      groupedBuckets.set(groupKey, group);
    }

    if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
      bucket.queuedKey = null;
    }
    group.buckets.set(model, bucket);
  }

  if (codexTouched) {
    const recomputeGroups = new Set();
    for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
      if (!bucket || !bucket.totals) continue;
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
      if (source !== "every-code") continue;
      const groupKey = groupBucketKey(source, hourStart);
      if (legacyGroups.has(groupKey) || groupedBuckets.has(groupKey)) continue;
      const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
      if (model !== DEFAULT_MODEL) continue;
      recomputeGroups.add(groupKey);
    }

    if (recomputeGroups.size > 0) {
      for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
        if (!bucket || !bucket.totals) continue;
        const parsed = parseBucketKey(key);
        const hourStart = parsed.hourStart;
        if (!hourStart) continue;
        const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
        const groupKey = groupBucketKey(source, hourStart);
        if (!recomputeGroups.has(groupKey)) continue;
        let group = groupedBuckets.get(groupKey);
        if (!group) {
          group = { source, hourStart, buckets: new Map() };
          groupedBuckets.set(groupKey, group);
        }
        if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
          bucket.queuedKey = null;
        }
        const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
        group.buckets.set(model, bucket);
      }
    }
  }

  const codexDominants = collectCodexDominantModels(hourlyState);

  const toAppend = [];
  for (const group of groupedBuckets.values()) {
    const unknownBucket = group.buckets.get(DEFAULT_MODEL) || null;
    const dominantModel = pickDominantModel(group.buckets);
    let alignedModel = null;
    if (unknownBucket?.alignedModel) {
      const normalized = normalizeModelInput(unknownBucket.alignedModel);
      alignedModel = normalized && normalized !== DEFAULT_MODEL ? normalized : null;
    }
    const zeroTotals = initTotals();
    const zeroKey = totalsKey(zeroTotals);

    if (dominantModel) {
      if (alignedModel && !group.buckets.has(alignedModel)) {
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model: alignedModel,
            hour_start: group.hourStart,
            input_tokens: zeroTotals.input_tokens,
            cached_input_tokens: zeroTotals.cached_input_tokens,
            cache_creation_input_tokens: zeroTotals.cache_creation_input_tokens,
            output_tokens: zeroTotals.output_tokens,
            reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
            total_tokens: zeroTotals.total_tokens,
            conversation_count: zeroTotals.conversation_count,
          }),
        );
      }
      if (
        unknownBucket &&
        !alignedModel &&
        unknownBucket.queuedKey &&
        unknownBucket.queuedKey !== zeroKey
      ) {
        if (unknownBucket.retractedUnknownKey !== zeroKey) {
          toAppend.push(
            JSON.stringify({
              source: group.source,
              model: DEFAULT_MODEL,
              hour_start: group.hourStart,
              input_tokens: zeroTotals.input_tokens,
              cached_input_tokens: zeroTotals.cached_input_tokens,
              output_tokens: zeroTotals.output_tokens,
              reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
              total_tokens: zeroTotals.total_tokens,
              conversation_count: zeroTotals.conversation_count,
            }),
          );
          unknownBucket.retractedUnknownKey = zeroKey;
        }
      }
      if (unknownBucket) unknownBucket.alignedModel = null;
      for (const [model, bucket] of group.buckets.entries()) {
        if (model === DEFAULT_MODEL) continue;
        let totals = bucket.totals;
        if (model === dominantModel && unknownBucket?.totals) {
          totals = cloneTotals(bucket.totals);
          addTotals(totals, unknownBucket.totals);
        }
        const key = totalsKey(totals);
        if (bucket.queuedKey === key) continue;
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model,
            hour_start: group.hourStart,
            input_tokens: totals.input_tokens,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: totals.output_tokens,
            reasoning_output_tokens: totals.reasoning_output_tokens,
            total_tokens: totals.total_tokens,
            conversation_count: totals.conversation_count,
          }),
        );
        bucket.queuedKey = key;
      }
      continue;
    }

    if (!unknownBucket?.totals) continue;
    let outputModel = DEFAULT_MODEL;
    if (group.source === "every-code") {
      const aligned = findNearestCodexModel(group.hourStart, codexDominants);
      if (aligned) outputModel = aligned;
    }
    const nextAligned = outputModel !== DEFAULT_MODEL ? outputModel : null;
    if (alignedModel && alignedModel !== nextAligned) {
      toAppend.push(
        JSON.stringify({
          source: group.source,
          model: alignedModel,
          hour_start: group.hourStart,
          input_tokens: zeroTotals.input_tokens,
          cached_input_tokens: zeroTotals.cached_input_tokens,
          output_tokens: zeroTotals.output_tokens,
          reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
          total_tokens: zeroTotals.total_tokens,
          conversation_count: zeroTotals.conversation_count,
        }),
      );
    }
    if (
      !alignedModel &&
      nextAligned &&
      unknownBucket.queuedKey &&
      unknownBucket.queuedKey !== zeroKey
    ) {
      if (unknownBucket.retractedUnknownKey !== zeroKey) {
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model: DEFAULT_MODEL,
            hour_start: group.hourStart,
            input_tokens: zeroTotals.input_tokens,
            cached_input_tokens: zeroTotals.cached_input_tokens,
            cache_creation_input_tokens: zeroTotals.cache_creation_input_tokens,
            output_tokens: zeroTotals.output_tokens,
            reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
            total_tokens: zeroTotals.total_tokens,
            conversation_count: zeroTotals.conversation_count,
          }),
        );
        unknownBucket.retractedUnknownKey = zeroKey;
      }
    }
    if (unknownBucket) unknownBucket.alignedModel = nextAligned;
    const key = totalsKey(unknownBucket.totals);
    const outputKey = outputModel === DEFAULT_MODEL ? key : `${key}|${outputModel}`;
    if (unknownBucket.queuedKey === outputKey) continue;
    toAppend.push(
      JSON.stringify({
        source: group.source,
        model: outputModel,
        hour_start: group.hourStart,
        input_tokens: unknownBucket.totals.input_tokens,
        cached_input_tokens: unknownBucket.totals.cached_input_tokens,
        cache_creation_input_tokens: unknownBucket.totals.cache_creation_input_tokens,
        output_tokens: unknownBucket.totals.output_tokens,
        reasoning_output_tokens: unknownBucket.totals.reasoning_output_tokens,
        total_tokens: unknownBucket.totals.total_tokens,
        conversation_count: unknownBucket.totals.conversation_count,
      }),
    );
    unknownBucket.queuedKey = outputKey;
  }

  if (legacyGroups.size > 0) {
    const grouped = new Map();
    for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
      if (!bucket || !bucket.totals) continue;
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const groupKey = groupBucketKey(parsed.source, hourStart);
      if (!legacyGroups.has(groupKey)) continue;

      let group = grouped.get(groupKey);
      if (!group) {
        group = {
          source: normalizeSourceInput(parsed.source) || DEFAULT_SOURCE,
          hourStart,
          models: new Set(),
          totals: initTotals(),
        };
        grouped.set(groupKey, group);
      }
      group.models.add(parsed.model || DEFAULT_MODEL);
      addTotals(group.totals, bucket.totals);
    }

    for (const group of grouped.values()) {
      const model = group.models.size === 1 ? [...group.models][0] : DEFAULT_MODEL;
      const key = totalsKey(group.totals);
      const groupKey = groupBucketKey(group.source, group.hourStart);
      if (groupQueued[groupKey] === key) continue;
      toAppend.push(
        JSON.stringify({
          source: group.source,
          model,
          hour_start: group.hourStart,
          input_tokens: group.totals.input_tokens,
          cached_input_tokens: group.totals.cached_input_tokens,
          cache_creation_input_tokens: group.totals.cache_creation_input_tokens,
          output_tokens: group.totals.output_tokens,
          reasoning_output_tokens: group.totals.reasoning_output_tokens,
          total_tokens: group.totals.total_tokens,
          conversation_count: group.totals.conversation_count,
        }),
      );
      groupQueued[groupKey] = key;
    }
  }

  hourlyState.groupQueued = groupQueued;

  if (toAppend.length > 0) {
    await fs.appendFile(queuePath, toAppend.join("\n") + "\n", "utf8");
  }

  return toAppend.length;
}

async function enqueueTouchedProjectBuckets({
  projectQueuePath,
  projectState,
  projectTouchedBuckets,
}) {
  if (
    !projectQueuePath ||
    !projectState ||
    !projectTouchedBuckets ||
    projectTouchedBuckets.size === 0
  )
    return 0;

  await ensureDir(path.dirname(projectQueuePath));

  const toAppend = [];
  for (const key of projectTouchedBuckets) {
    const bucket = projectState.buckets[key];
    if (!bucket || !bucket.totals) continue;
    const totals = bucket.totals;
    const queuedKey = totalsKey(totals);
    if (bucket.queuedKey === queuedKey) continue;
    const projectRef = typeof bucket.project_ref === "string" ? bucket.project_ref : null;
    const projectKey = typeof bucket.project_key === "string" ? bucket.project_key : null;
    if (!projectRef || !projectKey) continue;

    toAppend.push(
      JSON.stringify({
        project_ref: projectRef,
        project_key: projectKey,
        source: bucket.source,
        hour_start: bucket.hour_start,
        input_tokens: totals.input_tokens,
        cached_input_tokens: totals.cached_input_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        output_tokens: totals.output_tokens,
        reasoning_output_tokens: totals.reasoning_output_tokens,
        total_tokens: totals.total_tokens,
        conversation_count: totals.conversation_count,
      }),
    );
    bucket.queuedKey = queuedKey;
  }

  if (toAppend.length > 0) {
    await fs.appendFile(projectQueuePath, toAppend.join("\n") + "\n", "utf8");
  }

  return toAppend.length;
}

function pickDominantModel(buckets) {
  let dominantModel = null;
  let dominantTotal = -1;
  for (const [model, bucket] of buckets.entries()) {
    if (model === DEFAULT_MODEL) continue;
    const total = Number(bucket?.totals?.total_tokens || 0);
    if (
      dominantModel == null ||
      total > dominantTotal ||
      (total === dominantTotal && model < dominantModel)
    ) {
      dominantModel = model;
      dominantTotal = total;
    }
  }
  return dominantModel;
}

function cloneTotals(totals) {
  const cloned = initTotals();
  addTotals(cloned, totals || {});
  return cloned;
}

function collectCodexDominantModels(hourlyState) {
  const grouped = new Map();
  for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
    if (!bucket || !bucket.totals) continue;
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
    if (source !== DEFAULT_SOURCE) continue;
    const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
    if (model === DEFAULT_MODEL) continue;

    let models = grouped.get(hourStart);
    if (!models) {
      models = new Map();
      grouped.set(hourStart, models);
    }
    const total = Number(bucket.totals.total_tokens || 0);
    models.set(model, (models.get(model) || 0) + total);
  }

  const dominants = [];
  for (const [hourStart, models] of grouped.entries()) {
    let dominantModel = null;
    let dominantTotal = -1;
    for (const [model, total] of models.entries()) {
      if (
        dominantModel == null ||
        total > dominantTotal ||
        (total === dominantTotal && model < dominantModel)
      ) {
        dominantModel = model;
        dominantTotal = total;
      }
    }
    if (dominantModel) {
      dominants.push({ hourStart, model: dominantModel });
    }
  }

  return dominants;
}

function findNearestCodexModel(hourStart, dominants) {
  if (!hourStart || !dominants || dominants.length === 0) return null;
  const target = Date.parse(hourStart);
  if (!Number.isFinite(target)) return null;

  let best = null;
  for (const entry of dominants) {
    const candidate = Date.parse(entry.hourStart);
    if (!Number.isFinite(candidate)) continue;
    const diff = Math.abs(candidate - target);
    if (!best || diff < best.diff || (diff === best.diff && candidate < best.time)) {
      best = { diff, time: candidate, model: entry.model };
    }
  }

  return best ? best.model : null;
}

function normalizeHourlyState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const version = Number(state.version || 1);
  const rawBuckets = state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const buckets = {};
  const groupQueued = {};

  if (!Number.isFinite(version) || version < 2) {
    for (const [key, value] of Object.entries(rawBuckets)) {
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
      const normalizedKey = bucketKey(source, DEFAULT_MODEL, hourStart);
      buckets[normalizedKey] = value;
      if (value?.queuedKey) {
        groupQueued[groupBucketKey(source, hourStart)] = value.queuedKey;
      }
    }
    return {
      version: 3,
      buckets,
      groupQueued,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    };
  }

  for (const [key, value] of Object.entries(rawBuckets)) {
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const normalizedKey = bucketKey(parsed.source, parsed.model, hourStart);
    buckets[normalizedKey] = value;
  }

  const existingGroupQueued =
    state.groupQueued && typeof state.groupQueued === "object" ? state.groupQueued : {};

  return {
    version: 3,
    buckets,
    groupQueued: version >= 3 ? existingGroupQueued : {},
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeProjectState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const rawBuckets = state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const buckets = {};
  const rawProjects = state.projects && typeof state.projects === "object" ? state.projects : {};
  const projects = {};

  for (const [key, value] of Object.entries(rawBuckets)) {
    if (!key) continue;
    buckets[key] = value;
  }

  for (const [key, value] of Object.entries(rawProjects)) {
    if (!key || !value || typeof value !== "object") continue;
    projects[key] = { ...value };
  }

  return {
    version: 2,
    buckets,
    projects,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeOpencodeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const messages = state.messages && typeof state.messages === "object" ? state.messages : {};
  return {
    messages,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeMessageKeyPart(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function deriveOpencodeMessageKey(msg, fallback) {
  const sessionId = normalizeMessageKeyPart(msg?.sessionID || msg?.sessionId || msg?.session_id);
  const messageId = normalizeMessageKeyPart(msg?.id || msg?.messageID || msg?.messageId);
  if (sessionId && messageId) return `${sessionId}|${messageId}`;
  return fallback;
}

function getHourlyBucket(state, source, model, hourStart) {
  const buckets = state.buckets;
  const normalizedSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const normalizedModel = normalizeModelInput(model) || DEFAULT_MODEL;
  const key = bucketKey(normalizedSource, normalizedModel, hourStart);
  let bucket = buckets[key];
  if (!bucket || typeof bucket !== "object") {
    bucket = { totals: initTotals(), queuedKey: null };
    buckets[key] = bucket;
    return bucket;
  }

  if (!bucket.totals || typeof bucket.totals !== "object") {
    bucket.totals = initTotals();
  }

  if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
    bucket.queuedKey = null;
  }

  return bucket;
}

function getProjectBucket(state, projectKey, source, hourStart, projectRef) {
  const buckets = state.buckets;
  const normalizedSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const key = projectBucketKey(projectKey, normalizedSource, hourStart);
  let bucket = buckets[key];
  if (!bucket || typeof bucket !== "object") {
    bucket = {
      totals: initTotals(),
      queuedKey: null,
      project_key: projectKey,
      project_ref: projectRef,
      source: normalizedSource,
      hour_start: hourStart,
    };
    buckets[key] = bucket;
    return bucket;
  }

  if (!bucket.totals || typeof bucket.totals !== "object") {
    bucket.totals = initTotals();
  }

  if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
    bucket.queuedKey = null;
  }

  if (projectRef) bucket.project_ref = projectRef;
  if (projectKey) bucket.project_key = projectKey;
  bucket.source = normalizedSource;
  bucket.hour_start = hourStart;

  return bucket;
}

function initTotals() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    conversation_count: 0,
  };
}

function addTotals(target, delta) {
  target.input_tokens += delta.input_tokens || 0;
  target.cached_input_tokens += delta.cached_input_tokens || 0;
  target.cache_creation_input_tokens += delta.cache_creation_input_tokens || 0;
  target.output_tokens += delta.output_tokens || 0;
  target.reasoning_output_tokens += delta.reasoning_output_tokens || 0;
  target.total_tokens += delta.total_tokens || 0;
  target.conversation_count += delta.conversation_count || 0;
}

function totalsKey(totals) {
  return [
    totals.input_tokens || 0,
    totals.cached_input_tokens || 0,
    totals.cache_creation_input_tokens || 0,
    totals.output_tokens || 0,
    totals.reasoning_output_tokens || 0,
    totals.total_tokens || 0,
    totals.conversation_count || 0,
  ].join("|");
}

function toUtcHalfHourStart(ts) {
  const dt = new Date(ts);
  if (!Number.isFinite(dt.getTime())) return null;
  const minutes = dt.getUTCMinutes();
  const halfMinute = minutes >= 30 ? 30 : 0;
  const bucketStart = new Date(
    Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      halfMinute,
      0,
      0,
    ),
  );
  return bucketStart.toISOString();
}

function bucketKey(source, model, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const safeModel = normalizeModelInput(model) || DEFAULT_MODEL;
  return `${safeSource}${BUCKET_SEPARATOR}${safeModel}${BUCKET_SEPARATOR}${hourStart}`;
}

function projectBucketKey(projectKey, source, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  return `${projectKey}${BUCKET_SEPARATOR}${safeSource}${BUCKET_SEPARATOR}${hourStart}`;
}

function groupBucketKey(source, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  return `${safeSource}${BUCKET_SEPARATOR}${hourStart}`;
}

function parseBucketKey(key) {
  if (typeof key !== "string")
    return { source: DEFAULT_SOURCE, model: DEFAULT_MODEL, hourStart: "" };
  const first = key.indexOf(BUCKET_SEPARATOR);
  if (first <= 0) return { source: DEFAULT_SOURCE, model: DEFAULT_MODEL, hourStart: key };
  const second = key.indexOf(BUCKET_SEPARATOR, first + 1);
  if (second <= 0) {
    return { source: key.slice(0, first), model: DEFAULT_MODEL, hourStart: key.slice(first + 1) };
  }
  return {
    source: key.slice(0, first),
    model: key.slice(first + 1, second),
    hourStart: key.slice(second + 1),
  };
}

function normalizeSourceInput(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelInput(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function resolveProjectMetaForPath(startDir, cache) {
  if (!startDir || typeof startDir !== "string") return null;
  if (cache && cache.has(startDir)) return cache.get(startDir);

  const visited = [];
  let current = startDir;
  const root = path.parse(startDir).root;
  while (current) {
    if (cache && cache.has(current)) {
      const cached = cache.get(current);
      for (const entry of visited) cache.set(entry, cached);
      return cached;
    }
    visited.push(current);

    const configPath = await resolveGitConfigPath(current);
    if (configPath) {
      const remoteUrl = await readGitRemoteUrl(configPath);
      const projectRef = canonicalizeProjectRef(remoteUrl);
      const meta = { projectRef: projectRef || null, repoRoot: current };
      if (cache) {
        for (const entry of visited) cache.set(entry, meta);
      }
      return meta;
    }

    if (current === root) break;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  if (cache) {
    for (const entry of visited) cache.set(entry, null);
  }
  return null;
}

function hashRepoRoot(repoRoot) {
  return crypto.createHash("sha256").update(String(repoRoot)).digest("hex");
}

async function defaultPublicRepoResolver({ projectRef, repoRoot }) {
  return {
    status: "blocked",
    projectKey: null,
    projectRef: projectRef || null,
    repoRootHash: repoRoot ? hashRepoRoot(repoRoot) : null,
    reason: projectRef ? "local_only" : "missing_ref",
  };
}

function recordProjectMeta(projectState, meta) {
  if (!projectState || !meta || typeof meta !== "object") return;
  const repoRootHash = typeof meta.repoRootHash === "string" ? meta.repoRootHash : null;
  let projectKey = typeof meta.projectKey === "string" ? meta.projectKey : null;
  if (
    !projectKey &&
    repoRootHash &&
    projectState.projects &&
    typeof projectState.projects === "object"
  ) {
    for (const [key, entry] of Object.entries(projectState.projects)) {
      if (entry && entry.repo_root_hash === repoRootHash) {
        projectKey = key;
        break;
      }
    }
  }
  if (!projectKey) return;
  if (!projectState.projects || typeof projectState.projects !== "object") {
    projectState.projects = {};
  }
  const prev = projectState.projects[projectKey] || {};
  const status = typeof meta.status === "string" ? meta.status : null;
  const projectRef = typeof meta.projectRef === "string" ? meta.projectRef : null;
  const next = {
    ...prev,
    project_ref: projectRef || prev.project_ref || null,
    status: status || prev.status || null,
    repo_root_hash: repoRootHash || prev.repo_root_hash || null,
    updated_at: new Date().toISOString(),
  };
  if (status === "blocked" && prev.status !== "blocked") {
    next.purge_pending = true;
  } else if (status && status !== "blocked") {
    next.purge_pending = false;
  }
  projectState.projects[projectKey] = next;
}

async function resolveProjectContextForFile({
  filePath,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  if (!filePath) return null;
  return resolveProjectContextForPath({
    startDir: path.dirname(filePath),
    projectMetaCache,
    publicRepoCache,
    publicRepoResolver,
    projectState,
  });
}

async function resolveProjectContextForPath({
  startDir,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  if (!startDir) return null;
  const projectMeta = await resolveProjectMetaForPath(startDir, projectMetaCache);
  if (!projectMeta) return null;
  const resolver =
    typeof publicRepoResolver === "function" ? publicRepoResolver : defaultPublicRepoResolver;
  const meta = await resolver({
    projectRef: projectMeta.projectRef,
    repoRoot: projectMeta.repoRoot,
    cache: publicRepoCache,
  });
  const repoRootHash = projectMeta.repoRoot ? hashRepoRoot(projectMeta.repoRoot) : null;
  const normalized = {
    ...(meta || {}),
    projectRef: meta?.projectRef || projectMeta.projectRef,
    projectKey: meta?.projectKey || null,
    status: meta?.status || "blocked",
    repoRootHash: meta?.repoRootHash || repoRootHash,
  };
  recordProjectMeta(projectState, normalized);
  if (normalized.status !== "public_verified") {
    return { projectRef: normalized.projectRef, projectKey: null, status: normalized.status };
  }
  return {
    projectRef: normalized.projectRef,
    projectKey: normalized.projectKey,
    status: normalized.status,
  };
}

async function resolveGitConfigPath(rootDir) {
  const gitPath = path.join(rootDir, ".git");
  const st = await fs.stat(gitPath).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) {
    const configPath = path.join(gitPath, "config");
    const cfg = await fs.stat(configPath).catch(() => null);
    return cfg && cfg.isFile() ? configPath : null;
  }
  if (st.isFile()) {
    const content = await fs.readFile(gitPath, "utf8").catch(() => "");
    const match = content.match(/gitdir:\s*(.+)/i);
    if (!match) return null;
    let gitDir = match[1].trim();
    if (!gitDir) return null;
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.resolve(rootDir, gitDir);
    }
    const configPath = path.join(gitDir, "config");
    const cfg = await fs.stat(configPath).catch(() => null);
    if (cfg && cfg.isFile()) return configPath;

    const commonDirRaw = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
    const commonDirRel = commonDirRaw.trim();
    if (!commonDirRel) return null;
    let commonDir = commonDirRel;
    if (!path.isAbsolute(commonDir)) {
      commonDir = path.resolve(gitDir, commonDir);
    }
    const commonConfigPath = path.join(commonDir, "config");
    const commonCfg = await fs.stat(commonConfigPath).catch(() => null);
    return commonCfg && commonCfg.isFile() ? commonConfigPath : null;
  }
  return null;
}

async function readGitRemoteUrl(configPath) {
  const raw = await fs.readFile(configPath, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  const remotes = new Map();
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const sectionHeader = line.match(/^\s*\[[^\]]+\]\s*$/);
    if (sectionHeader) {
      const sectionMatch = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
      current = sectionMatch ? sectionMatch[1] : null;
      continue;
    }
    if (!current) continue;
    const urlMatch = line.match(/^\s*url\s*=\s*(.+)\s*$/i);
    if (urlMatch) {
      remotes.set(current, urlMatch[1].trim());
    }
  }

  if (remotes.has("origin")) return remotes.get("origin");
  const first = remotes.values().next();
  return first.done ? null : first.value;
}

function canonicalizeProjectRef(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  let ref = remoteUrl.trim();
  if (!ref) return null;

  if (ref.startsWith("file://")) return null;
  if (path.isAbsolute(ref) || path.win32.isAbsolute(ref)) return null;

  const gitAtMatch = ref.match(/^git@([^:]+):(.+)$/i);
  if (gitAtMatch) {
    ref = `https://${gitAtMatch[1]}/${gitAtMatch[2]}`;
  } else if (ref.startsWith("ssh://")) {
    try {
      const parsed = new URL(ref);
      ref = `https://${parsed.hostname}${parsed.pathname}`;
    } catch (_e) {
      return null;
    }
  } else if (ref.startsWith("git://")) {
    ref = `https://${ref.slice("git://".length)}`;
  } else if (ref.startsWith("http://")) {
    ref = `https://${ref.slice("http://".length)}`;
  } else if (!ref.startsWith("https://")) {
    return null;
  }

  try {
    const parsed = new URL(ref);
    if (!parsed.hostname) return null;
    ref = `https://${parsed.hostname}${parsed.pathname}`;
  } catch (_e) {
    return null;
  }

  ref = ref.replace(/\.git$/i, "");
  ref = ref.replace(/\/+$/, "");
  return ref || null;
}

function normalizeGeminiTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const input = toNonNegativeInt(tokens.input);
  const cached = toNonNegativeInt(tokens.cached);
  const output = toNonNegativeInt(tokens.output);
  const tool = toNonNegativeInt(tokens.tool);
  const thoughts = toNonNegativeInt(tokens.thoughts);
  const total = toNonNegativeInt(tokens.total);

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output + tool,
    reasoning_output_tokens: thoughts,
    total_tokens: total,
  };
}

function normalizeOpencodeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const input = toNonNegativeInt(tokens.input);
  const output = toNonNegativeInt(tokens.output);
  const reasoning = toNonNegativeInt(tokens.reasoning);
  const cached = toNonNegativeInt(tokens.cache?.read);
  const cacheWrite = toNonNegativeInt(tokens.cache?.write);
  const total = input + output + reasoning + cached + cacheWrite;

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function sameGeminiTotals(a, b) {
  if (!a || !b) return false;
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens &&
    a.total_tokens === b.total_tokens
  );
}

function diffGeminiTotals(current, previous) {
  if (!current || typeof current !== "object") return null;
  if (!previous || typeof previous !== "object") return current;
  if (sameGeminiTotals(current, previous)) return null;

  const totalReset = (current.total_tokens || 0) < (previous.total_tokens || 0);
  if (totalReset) return current;

  // Must include cache_creation_input_tokens in both the equality check and
  // the delta — OpenCode routes through this diff and its cache.write number
  // would otherwise be permanently reported as zero. Gemini itself always
  // emits cache_creation=0 so the extra field is a no-op for Gemini.
  const delta = {
    input_tokens: Math.max(0, (current.input_tokens || 0) - (previous.input_tokens || 0)),
    cached_input_tokens: Math.max(
      0,
      (current.cached_input_tokens || 0) - (previous.cached_input_tokens || 0),
    ),
    cache_creation_input_tokens: Math.max(
      0,
      (current.cache_creation_input_tokens || 0) - (previous.cache_creation_input_tokens || 0),
    ),
    output_tokens: Math.max(0, (current.output_tokens || 0) - (previous.output_tokens || 0)),
    reasoning_output_tokens: Math.max(
      0,
      (current.reasoning_output_tokens || 0) - (previous.reasoning_output_tokens || 0),
    ),
    total_tokens: Math.max(0, (current.total_tokens || 0) - (previous.total_tokens || 0)),
  };

  return isAllZeroUsage(delta) ? null : delta;
}

function extractTokenCount(obj) {
  const payload = obj?.payload;
  if (!payload) return null;
  if (payload.type === "token_count") {
    return { info: payload.info, timestamp: obj?.timestamp || null };
  }
  const msg = payload.msg;
  if (msg && msg.type === "token_count") {
    return { info: msg.info, timestamp: obj?.timestamp || null };
  }
  return null;
}

function pickDelta(lastUsage, totalUsage, prevTotals) {
  const hasLast = isNonEmptyObject(lastUsage);
  const hasTotal = isNonEmptyObject(totalUsage);
  const hasPrevTotals = isNonEmptyObject(prevTotals);

  // Codex rollout logs sometimes emit duplicate token_count records where total_token_usage does not
  // change between adjacent entries. Counting last_token_usage in those cases will double-count.
  if (hasTotal && hasPrevTotals && sameUsage(totalUsage, prevTotals)) {
    return null;
  }

  if (!hasLast && hasTotal && hasPrevTotals && totalsReset(totalUsage, prevTotals)) {
    const normalized = normalizeUsage(totalUsage);
    return isAllZeroUsage(normalized) ? null : normalized;
  }

  if (hasLast) {
    return normalizeUsage(lastUsage);
  }

  if (hasTotal && hasPrevTotals) {
    const delta = {};
    for (const k of [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
      "total_tokens",
    ]) {
      const a = Number(totalUsage[k]);
      const b = Number(prevTotals[k]);
      if (Number.isFinite(a) && Number.isFinite(b)) delta[k] = Math.max(0, a - b);
    }
    const normalized = normalizeUsage(delta);
    return isAllZeroUsage(normalized) ? null : normalized;
  }

  if (hasTotal) {
    const normalized = normalizeUsage(totalUsage);
    return isAllZeroUsage(normalized) ? null : normalized;
  }

  return null;
}

function normalizeUsage(u) {
  const out = {};
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    const n = Number(u[k] || 0);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return out;
}

function normalizeClaudeUsage(u) {
  const inputTokens = toNonNegativeInt(u?.input_tokens);
  const outputTokens = toNonNegativeInt(u?.output_tokens);
  const cacheCreation = toNonNegativeInt(u?.cache_creation_input_tokens);
  const cacheRead = toNonNegativeInt(u?.cache_read_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheCreation + cacheRead;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

function isNonEmptyObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0);
}

function isAllZeroUsage(u) {
  if (!u || typeof u !== "object") return true;
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    if (Number(u[k] || 0) !== 0) return false;
  }
  return true;
}

function sameUsage(a, b) {
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    if (toNonNegativeInt(a?.[k]) !== toNonNegativeInt(b?.[k])) return false;
  }
  return true;
}

function totalsReset(curr, prev) {
  const currTotal = curr?.total_tokens;
  const prevTotal = prev?.total_tokens;
  if (!isFiniteNumber(currTotal) || !isFiniteNumber(prevTotal)) return false;
  return currTotal < prevTotal;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function toNonNegativeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function coerceEpochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1e12) return Math.floor(n * 1000);
  return Math.floor(n);
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
}

async function walkClaudeProjects(dir, out) {
  const entries = await safeReadDir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkClaudeProjects(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(fullPath);
  }
}

async function walkOpencodeMessages(dir, out) {
  const entries = await safeReadDir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkOpencodeMessages(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("msg_") && entry.name.endsWith(".json"))
      out.push(fullPath);
  }
}

// ---------------------------------------------------------------------------
// OpenCode SQLite DB reader (v1.2+ stores messages in opencode.db)
// ---------------------------------------------------------------------------

function readOpencodeDbMessages(dbPath) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const sql = `SELECT id, session_id, time_updated, data FROM message WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC`;
  let raw;
  try {
    raw = cp.execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (_e) {
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (_e) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.data !== "string") continue;
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (_e) {
      continue;
    }
    const tokens = data?.tokens;
    if (!tokens || typeof tokens !== "object") continue;
    // Skip messages with no meaningful token data
    const hasTokens =
      toNonNegativeInt(tokens.input) > 0 ||
      toNonNegativeInt(tokens.output) > 0 ||
      toNonNegativeInt(tokens.reasoning) > 0;
    if (!hasTokens) continue;
    out.push({
      id: row.id || data.id,
      sessionID: row.session_id || data.sessionID,
      timeUpdated: row.time_updated || 0,
      data,
    });
  }
  return out;
}

async function parseOpencodeDbIncremental({
  dbMessages,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let messagesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const messages = Array.isArray(dbMessages) ? dbMessages : [];
  const totalMessages = messages.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const opencodeState = normalizeOpencodeState(cursors?.opencode);
  const messageIndex = opencodeState.messages;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "opencode";

  for (let idx = 0; idx < messages.length; idx++) {
    const entry = messages[idx];
    const msg = entry.data;
    if (!msg) continue;

    // DB stores id/sessionID as separate columns; inject into msg for key derivation
    const msgForKey = { ...msg };
    if (entry.id && !msgForKey.id) msgForKey.id = entry.id;
    if (entry.sessionID && !msgForKey.sessionID) msgForKey.sessionID = entry.sessionID;
    const messageKey = deriveOpencodeMessageKey(msgForKey, null);
    if (!messageKey) {
      messagesProcessed += 1;
      continue;
    }

    // Skip messages already indexed (from prior JSON-file parsing or previous DB sync)
    const prev = messageIndex[messageKey];
    const lastTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;

    const currentTotals = normalizeOpencodeTokens(msg?.tokens);
    if (!currentTotals) {
      messagesProcessed += 1;
      continue;
    }

    const delta = diffGeminiTotals(currentTotals, lastTotals);
    if (!delta || isAllZeroUsage(delta)) {
      // Update index with current totals even if no delta (normalization may have changed)
      if (!sameGeminiTotals(currentTotals, lastTotals)) {
        messageIndex[messageKey] = {
          lastTotals: currentTotals,
          updatedAt: new Date().toISOString(),
        };
      }
      messagesProcessed += 1;
      if (cb) {
        cb({
          index: idx + 1,
          total: totalMessages,
          messagesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }
    delta.conversation_count = 1;

    const timestampMs = coerceEpochMs(msg?.time?.completed) || coerceEpochMs(msg?.time?.created);
    if (!timestampMs) {
      messagesProcessed += 1;
      continue;
    }

    const tsIso = new Date(timestampMs).toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) {
      messagesProcessed += 1;
      continue;
    }

    const model = normalizeModelInput(msg?.modelID || msg?.model || msg?.modelId) || DEFAULT_MODEL;
    const bucket = getHourlyBucket(hourlyState, defaultSource, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(defaultSource, model, bucketStart));

    if (projectEnabled) {
      const projectContext = await resolveProjectContextForDb({
        msg,
        projectMetaCache,
        publicRepoCache,
        publicRepoResolver,
        projectState,
      });
      const projectRef = projectContext?.projectRef || null;
      const projectKey = projectContext?.projectKey || null;
      if (projectKey && projectState && projectTouchedBuckets) {
        const projectBucket = getProjectBucket(
          projectState,
          projectKey,
          defaultSource,
          bucketStart,
          projectRef,
        );
        addTotals(projectBucket.totals, delta);
        projectTouchedBuckets.add(projectBucketKey(projectKey, defaultSource, bucketStart));
      }
    }

    messageIndex[messageKey] = {
      lastTotals: currentTotals,
      updatedAt: new Date().toISOString(),
    };
    messagesProcessed += 1;
    eventsAggregated += 1;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalMessages,
        messagesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  opencodeState.updatedAt = new Date().toISOString();
  cursors.opencode = opencodeState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { messagesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

// Resolve project context from DB message (no file path available)
async function resolveProjectContextForDb({
  msg,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  const cwd = msg?.path?.cwd;
  if (!cwd || typeof cwd !== "string") return null;
  return resolveProjectContextForPath({
    startDir: cwd,
    projectMetaCache,
    publicRepoCache,
    publicRepoResolver,
    projectState,
  });
}

// ── Cursor (API-based) ──

/**
 * Incremental parser for Cursor usage data fetched via API.
 *
 * Unlike other parsers that read local files, this one receives pre-parsed
 * CSV records from cursor-config.js and aggregates them into 30-min buckets.
 *
 * Incremental state is tracked in `cursors.cursorApi.lastRecordTimestamp`.
 */
async function parseCursorApiIncremental({
  records,
  cursors,
  queuePath,
  onProgress,
  source,
}) {
  await ensureDir(path.dirname(queuePath));
  const defaultSource = normalizeSourceInput(source) || "cursor";
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();

  // Incremental: skip records we already processed
  const lastTs = cursors?.cursorApi?.lastRecordTimestamp || null;
  let latestTs = lastTs;
  let eventsAggregated = 0;
  const cb = typeof onProgress === "function" ? onProgress : null;
  const total = records.length;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const recordDate = record.date;
    if (!recordDate) continue;

    // Skip records we already processed (CSV is ordered newest-first)
    if (lastTs && recordDate <= lastTs) continue;

    const { normalizeCursorUsage } = require("./cursor-config");
    const delta = normalizeCursorUsage(record);
    if (isAllZeroUsage(delta)) continue;

    delta.conversation_count = 1;

    const bucketStart = toUtcHalfHourStart(recordDate);
    if (!bucketStart) continue;

    const model = normalizeModelInput(record.model) || DEFAULT_MODEL;
    const bucket = getHourlyBucket(hourlyState, defaultSource, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(defaultSource, model, bucketStart));

    eventsAggregated += 1;

    // Track latest timestamp
    if (!latestTs || recordDate > latestTs) {
      latestTs = recordDate;
    }

    if (cb && (i % 200 === 0 || i === records.length - 1)) {
      cb({
        index: i + 1,
        total,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;

  // Update cursor state
  if (!cursors.cursorApi) cursors.cursorApi = {};
  if (latestTs && latestTs !== lastTs) {
    cursors.cursorApi.lastRecordTimestamp = latestTs;
  }
  cursors.cursorApi.updatedAt = new Date().toISOString();

  return { recordsProcessed: total, eventsAggregated, bucketsQueued };
}

// ---------------------------------------------------------------------------
// Kiro token tracking (reads from devdata.sqlite or tokens_generated.jsonl)
// ---------------------------------------------------------------------------

function resolveKiroBasePath() {
  const home = require("node:os").homedir();
  return path.join(
    home,
    "Library",
    "Application Support",
    "Kiro",
    "User",
    "globalStorage",
    "kiro.kiroagent",
  );
}

function resolveKiroDbPath() {
  return path.join(resolveKiroBasePath(), "dev_data", "devdata.sqlite");
}

function resolveKiroJsonlPath() {
  return path.join(resolveKiroBasePath(), "dev_data", "tokens_generated.jsonl");
}

function readKiroDbTokens(dbPath, sinceId) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const minId = Number.isFinite(sinceId) && sinceId > 0 ? sinceId : 0;
  const sql = `SELECT id, model, provider, tokens_prompt, tokens_generated, timestamp FROM tokens_generated WHERE id > ${minId} ORDER BY id ASC`;
  let raw;
  try {
    raw = cp.execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (_e) {
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (_e) {
    return [];
  }
  return Array.isArray(rows) ? rows : [];
}

// Read Kiro token data from JSONL fallback (tokens_generated.jsonl).
// Each line: {"model":"agent","provider":"kiro","promptTokens":N,"generatedTokens":N}
// The fallback file does not include per-row timestamps, so newly appended rows are
// bucketed using the file mtime observed during this sync. We track a separate JSONL
// cursor so it never shares state with the SQLite path.
function countKiroJsonlLines(jsonlPath) {
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) return 0;
  try {
    const raw = fssync.readFileSync(jsonlPath, "utf8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch (_e) {
    return 0;
  }
}

function readKiroJsonlTokens(jsonlPath, sinceLineIndex) {
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) {
    return { rows: [], lineCount: 0, reset: false };
  }
  const startLine = Number.isFinite(sinceLineIndex) && sinceLineIndex > 0 ? sinceLineIndex : 0;
  let raw;
  try {
    raw = fssync.readFileSync(jsonlPath, "utf8");
  } catch (_e) {
    return { rows: [], lineCount: 0, reset: false };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const lineCount = lines.length;
  if (startLine > lineCount) {
    return { rows: [], lineCount, reset: true };
  }
  let mtime;
  try {
    mtime = fssync.statSync(jsonlPath).mtime.toISOString();
  } catch (_e) {
    mtime = new Date().toISOString();
  }
  const timestamp = mtime.replace("T", " ").replace("Z", "").slice(0, 19);
  const rows = [];
  for (let i = startLine; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      rows.push({
        id: i + 1,
        model: obj.model || "agent",
        provider: obj.provider || "kiro",
        tokens_prompt: obj.promptTokens || 0,
        tokens_generated: obj.generatedTokens || 0,
        timestamp,
      });
    } catch (_e) {
      // skip malformed lines
    }
  }
  return { rows, lineCount, reset: false };
}

// Build a sorted timeline of model usage from Kiro .chat metadata files
function buildKiroModelTimeline(basePath) {
  const timeline = []; // [{ startMs, endMs, model }]
  if (!basePath || !fssync.existsSync(basePath)) return timeline;
  let dirs;
  try {
    dirs = fssync.readdirSync(basePath, { withFileTypes: true });
  } catch (_e) {
    return timeline;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(basePath, entry.name);
    let files;
    try {
      files = fssync.readdirSync(dirPath).filter((f) => f.endsWith(".chat"));
    } catch (_e) {
      continue;
    }
    for (const file of files) {
      try {
        const raw = fssync.readFileSync(path.join(dirPath, file), "utf8");
        const data = JSON.parse(raw);
        const meta = data?.metadata;
        if (!meta?.modelId || !meta?.startTime) continue;
        timeline.push({
          startMs: meta.startTime,
          endMs: meta.endTime || meta.startTime,
          model: String(meta.modelId),
        });
      } catch (_e) {}
    }
  }
  timeline.sort((a, b) => a.startMs - b.startMs);
  return timeline;
}

// Find the model for a given UTC timestamp string using the .chat timeline
function resolveKiroModel(timeline, utcTimestamp) {
  if (!timeline.length || !utcTimestamp) return null;
  const ts = new Date(utcTimestamp).getTime();
  if (!Number.isFinite(ts)) return null;

  // Binary search for the closest .chat entry
  let lo = 0;
  let hi = timeline.length - 1;
  let best = null;
  let bestDist = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = timeline[mid];
    // Check if timestamp falls within the .chat execution window
    if (ts >= entry.startMs && ts <= entry.endMs) return entry.model;
    const dist = Math.min(Math.abs(ts - entry.startMs), Math.abs(ts - entry.endMs));
    if (dist < bestDist) {
      bestDist = dist;
      best = entry.model;
    }
    if (ts < entry.startMs) hi = mid - 1;
    else lo = mid + 1;
  }
  // Only match if within 10 minutes
  return bestDist < 10 * 60 * 1000 ? best : null;
}

// Normalize Kiro internal model IDs to readable names
// e.g. "CLAUDE_SONNET_4_20250514_V1_0" → "claude-sonnet-4"
function normalizeKiroModelName(raw) {
  if (!raw || typeof raw !== "string") return null;
  let name = raw.trim();
  if (!name) return null;
  // Already lowercase with dashes (e.g. "claude-opus-4.5") → keep as-is
  if (name === name.toLowerCase() && name.includes("-")) return name;
  // UPPER_SNAKE_CASE internal names: strip date/version suffixes, convert to lowercase-dash
  name = name
    .replace(/_\d{8}_V\d+_\d+$/i, "") // remove _20250514_V1_0
    .replace(/_V\d+$/i, "") // remove _V1
    .toLowerCase()
    .replace(/_/g, "-");
  return name || null;
}

async function parseKiroIncremental({ dbPath, jsonlPath, cursors, queuePath, onProgress }) {
  await ensureDir(path.dirname(queuePath));
  const kiroState = cursors.kiro && typeof cursors.kiro === "object" ? cursors.kiro : {};
  const lastDbId = typeof kiroState.lastDbId === "number"
    ? kiroState.lastDbId
    : (typeof kiroState.lastId === "number" ? kiroState.lastId : 0);
  const jsonlState = kiroState.jsonl && typeof kiroState.jsonl === "object" ? kiroState.jsonl : {};
  const lastJsonlLine = typeof jsonlState.lastLine === "number" ? jsonlState.lastLine : 0;

  const resolvedDbPath = dbPath || resolveKiroDbPath();
  const resolvedJsonlPath = jsonlPath || resolveKiroJsonlPath();

  // Try SQLite first, fall back to JSONL.
  let rows = [];
  let nextDbId = lastDbId;
  let nextJsonlLine = lastJsonlLine;
  let usingDb = false;
  if (fssync.existsSync(resolvedDbPath)) {
    rows = readKiroDbTokens(resolvedDbPath, lastDbId);
    usingDb = true;
    // DB and JSONL are siblings for the same usage events. If the DB ever
    // disappears (corrupted / wiped) and we fall back to JSONL in a later
    // run, we must not re-read lines that the DB path already consumed.
    // Advance the JSONL line cursor to the current file tail.
    if (fssync.existsSync(resolvedJsonlPath)) {
      const tailLineCount = countKiroJsonlLines(resolvedJsonlPath);
      if (tailLineCount > nextJsonlLine) nextJsonlLine = tailLineCount;
    }
  } else if (fssync.existsSync(resolvedJsonlPath)) {
    const jsonlResult = readKiroJsonlTokens(resolvedJsonlPath, lastJsonlLine);
    rows = jsonlResult.rows;
    nextJsonlLine = jsonlResult.lineCount;
    if (jsonlResult.reset) {
      cursors.kiro = {
        ...kiroState,
        lastDbId,
        jsonl: { lastLine: jsonlResult.lineCount, updatedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    }
  } else {
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }
  if (rows.length === 0) {
    cursors.kiro = {
      ...kiroState,
      lastDbId,
      jsonl: { lastLine: nextJsonlLine, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // Build model timeline from .chat files for model name resolution
  const basePath = resolveKiroBasePath();
  const modelTimeline = buildKiroModelTimeline(basePath);

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let eventsAggregated = 0;
  let maxId = lastDbId;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const inputTokens = toNonNegativeInt(row.tokens_prompt);
    const outputTokens = toNonNegativeInt(row.tokens_generated);
    if (inputTokens === 0 && outputTokens === 0) continue;

    // timestamp format: "2026-01-09 15:25:30" (UTC from SQLite DEFAULT CURRENT_TIMESTAMP)
    const ts = row.timestamp ? row.timestamp.replace(" ", "T") + "Z" : null;
    const bucketStart = ts ? toUtcHalfHourStart(ts) : null;
    if (!bucketStart) continue;

    // Resolve actual model from .chat timeline, fallback to "kiro-agent"
    const resolvedModel = resolveKiroModel(modelTimeline, ts);
    const model = normalizeKiroModelName(resolvedModel) || "kiro-agent";

    const delta = {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
      total_tokens: inputTokens + outputTokens,
      conversation_count: 1,
    };

    const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("kiro", model, bucketStart));
    eventsAggregated++;

    if (usingDb && row.id && row.id > maxId) maxId = row.id;

    if (cb) {
      cb({
        index: i + 1,
        total: rows.length,
        recordsProcessed: i + 1,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiro = {
    ...kiroState,
    lastId: maxId,
    lastDbId: maxId,
    jsonl: { lastLine: nextJsonlLine, updatedAt },
    updatedAt,
  };

  return { recordsProcessed: rows.length, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes Agent — SQLite-based (sessions table in ~/.hermes/state.db)
// ─────────────────────────────────────────────────────────────────────────────

function resolveHermesDbPath() {
  const home = require("node:os").homedir();
  return path.join(home, ".hermes", "state.db");
}

function readHermesSessions(dbPath, sinceEpoch) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const since = Number.isFinite(sinceEpoch) && sinceEpoch > 0 ? sinceEpoch : 0;
  const sql = `SELECT id, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count FROM sessions WHERE started_at > ${since} AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR reasoning_tokens > 0) ORDER BY started_at ASC`;
  let raw;
  try {
    raw = cp.execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (_e) {
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (_e) {
    return [];
  }
  return Array.isArray(rows) ? rows : [];
}

async function parseHermesIncremental({ dbPath, cursors, queuePath, onProgress }) {
  await ensureDir(path.dirname(queuePath));
  const hermesState = cursors.hermes && typeof cursors.hermes === "object" ? cursors.hermes : {};
  const lastStartedAt =
    typeof hermesState.lastStartedAt === "number" ? hermesState.lastStartedAt : 0;

  const resolvedDbPath = dbPath || resolveHermesDbPath();
  if (!fssync.existsSync(resolvedDbPath)) {
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const rows = readHermesSessions(resolvedDbPath, lastStartedAt);
  if (rows.length === 0) {
    cursors.hermes = { ...hermesState, lastStartedAt, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let eventsAggregated = 0;
  let maxStartedAt = lastStartedAt;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const inputTokens = toNonNegativeInt(row.input_tokens);
    const outputTokens = toNonNegativeInt(row.output_tokens);
    const cacheRead = toNonNegativeInt(row.cache_read_tokens);
    const cacheWrite = toNonNegativeInt(row.cache_write_tokens);
    const reasoning = toNonNegativeInt(row.reasoning_tokens);
    if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && reasoning === 0) continue;

    // Prefer ended_at for bucket placement; fall back to started_at
    const epochSec = row.ended_at || row.started_at;
    if (!epochSec || !Number.isFinite(epochSec)) continue;
    const tsIso = new Date(epochSec * 1000).toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) continue;

    const model = normalizeModelInput(row.model) || "hermes-agent";

    const delta = {
      input_tokens: inputTokens,
      cached_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      output_tokens: outputTokens,
      reasoning_output_tokens: reasoning,
      total_tokens: inputTokens + outputTokens + cacheRead + cacheWrite + reasoning,
      conversation_count: toNonNegativeInt(row.message_count) || 1,
    };

    const bucket = getHourlyBucket(hourlyState, "hermes", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("hermes", model, bucketStart));
    eventsAggregated++;

    if (row.started_at > maxStartedAt) maxStartedAt = row.started_at;

    if (cb) {
      cb({
        index: i + 1,
        total: rows.length,
        recordsProcessed: i + 1,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.hermes = { ...hermesState, lastStartedAt: maxStartedAt, updatedAt };

  return { recordsProcessed: rows.length, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kimi — passive JSONL reader (~/.kimi/sessions/**/wire.jsonl)
// No hook installation needed; Kimi writes wire.jsonl automatically.

function resolveKimiDefaultModel(env = process.env) {
  const fallback = "kimi-for-coding";
  try {
    const home = env.HOME || require("node:os").homedir();
    const cfgPath = path.join(env.KIMI_HOME || path.join(home, ".kimi"), "config.toml");
    const raw = fssync.readFileSync(cfgPath, "utf8");
    const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    if (!defaultMatch) return fallback;
    const sectionKey = defaultMatch[1];
    const escaped = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionRe = new RegExp(
      `\\[models\\."${escaped}"\\]([\\s\\S]*?)(?:\\n\\[|$)`,
    );
    const section = raw.match(sectionRe);
    if (section) {
      const modelMatch = section[1].match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (modelMatch && modelMatch[1]) return modelMatch[1];
    }
    if (sectionKey.includes("/")) return sectionKey.split("/").pop();
    return sectionKey || fallback;
  } catch {
    return fallback;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Kiro CLI — reads historical conversation state from
// ~/Library/Application Support/kiro-cli/data.sqlite3 (table conversations_v2).
// Kiro CLI does NOT store explicit token counts locally. Each request row
// carries: user_prompt_length (chars), response_size (chars), model_id,
// request_start_timestamp_ms, message_id. We approximate tokens at 4 chars /
// token. Source is merged with Kiro IDE (source='kiro') and canonicalized
// model names are used so CLI and IDE rows collapse when they refer to the
// same underlying Bedrock model. Cursor state is per-request-id so mutable
// requests can be reprocessed (subtract-old/add-new on fingerprint change).
// ─────────────────────────────────────────────────────────────────────────────

const KIRO_CLI_CHARS_PER_TOKEN = 4;

function resolveKiroCliDbPath(env = process.env) {
  if (env.KIRO_CLI_DB_PATH) return env.KIRO_CLI_DB_PATH;
  const home = env.HOME || require("node:os").homedir();
  return path.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
}

// Bug-4: canonical UUID shape — 8-4-4-4-12 hex groups. The looser
// /^[0-9a-f-]{36}\.json$/ form accepted `36 hyphens`.json or 36 hex with
// no hyphens. kiro-cli writes proper UUIDs; lock to the canonical shape.
const KIRO_CLI_SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

// Lists ~/.kiro/sessions/cli/{uuid}.json files. Includes files whose sibling
// .lock is present — we read those as tail-only snapshots so a running
// session's completed turns still land in the queue on the next sync. The
// .json files are rewritten atomically by kiro-cli on each turn flush, so
// a stale read just means we'll pick up the rest next time.
//
// TASK-014: env.HOME is honored (symmetric with resolveKiroCliDbPath) so
// callers can redirect to a tmp home for hermetic tests/CI.
function resolveKiroCliSessionFiles(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  const kiroHome = env.KIRO_HOME || path.join(home, ".kiro");
  const sessionsDir = path.join(kiroHome, "sessions", "cli");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  try {
    for (const entry of fssync.readdirSync(sessionsDir)) {
      // TASK-003: only canonical {uuid}.json files; backups, scratch,
      // typos are skipped so they don't feed JSON.parse garbage.
      if (!KIRO_CLI_SESSION_FILE_RE.test(entry)) continue;
      files.push(path.join(sessionsDir, entry));
    }
  } catch {
    // ignore read errors
  }
  return files;
}

// Build char-count maps from a .jsonl sibling file. Lets us approximate
// per-turn tokens when the live session's input_token_count /
// output_token_count fields are 0 (kiro-cli does not persist real token
// counts; billing is credit-based).
//
// Returns:
//   byMessage:       message_id -> assistant+toolUse char count
//   messageKind:     message_id -> jsonl event kind
//   turnPromptChars: turn_index -> input chars attributed to that turn
//
// Input attribution: Kiro CLI's turn.message_ids only records
// AssistantMessage / ToolResults ids, NEVER the user Prompt id. So the
// Prompt event is invisible if you look it up by message_id. To recover
// the per-turn user input, we walk the jsonl in timestamp order and buffer
// Prompt chars until the next AssistantMessage that belongs to a turn
// (turnMessageIds provides that mapping). The first such AssistantMessage
// "claims" the buffered Prompt chars for its turn, and the buffer resets.
// Later cycles within the same turn (Assistant → ToolResults → Assistant)
// do not re-attribute.
async function readKiroCliMessageChars(jsonlPath, turnMessageIds) {
  const result = {
    byMessage: new Map(),
    messageKind: new Map(),
    turnPromptChars: new Map(),
  };
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) return result;
  // TASK-005: stream via readline so multi-MB .jsonl files (heavy tool-use
  // sessions) don't block the sync event loop by buffering whole-file.
  let stream;
  try {
    stream = fssync.createReadStream(jsonlPath, { encoding: "utf8" });
  } catch {
    return result;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const midToTurn =
    turnMessageIds instanceof Map ? turnMessageIds : new Map();
  const attributedTurns = new Set();
  let pendingPromptChars = 0;
  // Bug-5: wrap the streamed iteration. Mid-read errors (file deleted or
  // truncated while kiro-cli is writing) would otherwise propagate up and
  // crash the whole sync pass. On error we return the partial result and
  // let the next sync re-read fresh.
  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const data = evt && evt.data;
      if (!data || typeof data !== "object") continue;
      const mid = data.message_id;
      if (!mid) continue;
      const content = Array.isArray(data.content) ? data.content : [];
      let chars = 0;
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.kind === "text" && typeof c.data === "string") {
          chars += c.data.length;
        } else if (c.kind === "toolUse" && c.data && typeof c.data === "object") {
          try {
            chars += JSON.stringify(c.data.input || {}).length;
          } catch {
            // ignore
          }
        }
      }
      result.byMessage.set(mid, (result.byMessage.get(mid) || 0) + chars);
      if (!result.messageKind.has(mid)) result.messageKind.set(mid, evt.kind);

      if (evt.kind === "Prompt") {
        pendingPromptChars += chars;
      } else if (evt.kind === "AssistantMessage" && midToTurn.has(mid)) {
        const turnIdx = midToTurn.get(mid);
        if (!attributedTurns.has(turnIdx)) {
          result.turnPromptChars.set(turnIdx, pendingPromptChars);
          attributedTurns.add(turnIdx);
          pendingPromptChars = 0;
        }
      }
    }
  } catch {
    // partial data — return what we have.
  }
  return result;
}

// Extract flat per-turn records from a live session .json + its .jsonl
// sibling. Returns [{ request_id, model_id, request_start_timestamp_ms,
// input_tokens, output_tokens }]. We use the same request_id dedup slot as
// the SQLite path so mutations (turn rewritten on next flush) go through
// the subtract-old/add-new path in parseKiroCliIncremental.
async function readKiroCliSessionTurns(jsonPath) {
  if (!jsonPath || !fssync.existsSync(jsonPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fssync.readFileSync(jsonPath, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const turns = Array.isArray(
    parsed?.session_state?.conversation_metadata?.user_turn_metadatas,
  )
    ? parsed.session_state.conversation_metadata.user_turn_metadatas
    : [];
  if (turns.length === 0) return [];

  const modelInfo = parsed?.session_state?.rts_model_state?.model_info || null;
  const sessionModelId =
    (modelInfo && (modelInfo.model_id || modelInfo.model_name)) || null;
  const sessionId =
    typeof parsed.session_id === "string" ? parsed.session_id : path.basename(jsonPath, ".json");

  // Build turn_index -> Set(message_id) so the jsonl walker can attribute
  // orphaned Prompt events (not referenced by turn.message_ids) to the
  // right turn. The turn.message_ids list only contains AssistantMessage
  // and ToolResults ids; Prompt ids appear in the jsonl stream only.
  const turnMessageIds = new Map();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || !Array.isArray(t.message_ids)) continue;
    for (const mid of t.message_ids) {
      if (typeof mid === "string" && mid) turnMessageIds.set(mid, i);
    }
  }

  // Load sibling .jsonl for char-count fallback.
  const jsonlPath = jsonPath.replace(/\.json$/, ".jsonl");
  const charMap = await readKiroCliMessageChars(jsonlPath, turnMessageIds);

  const flat = [];
  for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
    const turn = turns[turnIdx];
    if (!turn || typeof turn !== "object") continue;
    // TASK-001: preserve the integer 0. `|| null` would coerce a valid
    // loop_id.rand=0 into a message_id fallback, splitting the dedup
    // namespace across runs that see 0 vs runs that don't.
    const loopRand =
      turn.loop_id && typeof turn.loop_id === "object"
        ? turn.loop_id.rand ?? turn.loop_id.seed ?? null
        : null;
    const messageIds = Array.isArray(turn.message_ids) ? turn.message_ids : [];
    const requestId = loopRand != null ? `${sessionId}:${loopRand}` : (messageIds[0] || null);
    if (!requestId) continue;

    // Prefer real token counts if kiro-cli populated them.
    let inputTokens = toNonNegativeInt(turn.input_token_count);
    let outputTokens = toNonNegativeInt(turn.output_token_count);

    if (inputTokens === 0 && outputTokens === 0) {
      // Fall back to char-count approximation. Input chars come from the
      // sequential Prompt attribution (see readKiroCliMessageChars);
      // output chars come from AssistantMessage+toolUse bodies referenced
      // by turn.message_ids.
      const promptChars = charMap.turnPromptChars.get(turnIdx) || 0;
      let assistantChars = 0;
      for (const mid of messageIds) {
        const chars = charMap.byMessage.get(mid) || 0;
        const kind = charMap.messageKind.get(mid);
        if (kind === "AssistantMessage") assistantChars += chars;
      }
      inputTokens = Math.floor(promptChars / KIRO_CLI_CHARS_PER_TOKEN);
      outputTokens = Math.floor(assistantChars / KIRO_CLI_CHARS_PER_TOKEN);
    }

    // TASK-006: timestamp precedence matches SQLite's
    // request_start_timestamp_ms so a turn that migrates SQLite ↔
    // session-file buckets identically across tiers (previously a turn
    // straddling a half-hour boundary bucketed differently per source
    // because session files use end_timestamp while SQLite uses start).
    //   1. turn.request_start_timestamp_ms   (numeric ms, SQLite shape)
    //   2. turn.start_timestamp              (ISO string)
    //   3. turn.end_timestamp                (ISO string, legacy fallback)
    let tsMs = NaN;
    if (Number.isFinite(Number(turn.request_start_timestamp_ms))) {
      tsMs = Number(turn.request_start_timestamp_ms);
    } else if (turn.start_timestamp) {
      tsMs = Date.parse(turn.start_timestamp);
    } else if (turn.end_timestamp) {
      tsMs = Date.parse(turn.end_timestamp);
    }
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;

    flat.push({
      request_id: requestId,
      session_model_id: sessionModelId,
      message_id: messageIds[0] || null,
      model_id: turn.model_id || sessionModelId,
      request_start_timestamp_ms: tsMs,
      // D-1 / Bug-2: tag with session_id so the retraction pass can match
      // session-origin entries even when the requestId format has no
      // colon (no-loop_id fallback uses a bare message_id UUID that would
      // otherwise be indistinguishable from SQLite's UUID keys).
      session_id: sessionId,
      // For the parser, we feed the ALREADY-approximated tokens directly via
      // a special sentinel field. The parser will divide chars by
      // KIRO_CLI_CHARS_PER_TOKEN; bypass that by pre-multiplying here.
      user_prompt_length: inputTokens * KIRO_CLI_CHARS_PER_TOKEN,
      response_size: outputTokens * KIRO_CLI_CHARS_PER_TOKEN,
    });
  }
  return flat;
}

// Canonicalize a Kiro-CLI-emitted model id so IDE and CLI rows collapse when
// they refer to the same underlying Bedrock model. Examples:
//   anthropic.claude-sonnet-4-20250514-v1:0  -> claude-sonnet-4
//   claude-opus-4.6                           -> claude-opus-4.6
//   claude-sonnet-4.5                         -> claude-sonnet-4.5
//   auto                                      -> null (caller uses 'kiro-cli-agent')
//   <unknown/falsy>                           -> null (caller falls back to 'kiro-cli-agent')
//
// "auto" is treated as unknown because Kiro CLI's auto-routing does not
// expose the underlying Bedrock model id in the session file. Returning
// null lets pricing fall into the kiro-cli-agent bucket (sonnet-4 rates)
// rather than the literal "auto" string which matches Cursor's composer-1
// pricing by accident.
function canonicalizeKiroCliModelId(raw) {
  if (!raw || typeof raw !== "string") return null;
  let name = raw.trim();
  if (!name) return null;
  name = name.toLowerCase();
  if (name === "auto") return null;
  // Strip provider prefix (anthropic., aws., openai., or a full Bedrock ARN).
  name = name.replace(
    /^(?:arn:aws:bedrock:[^:]*:[^:]*:(?:foundation-model\/)?|anthropic\.|openai\.|aws\.)/,
    "",
  );
  // Strip Bedrock revision suffix `:N`.
  name = name.replace(/:\d+$/, "");
  // Strip date + vN suffix (e.g. "-20250514-v1"), or lone "-vN", or lone date.
  name = name.replace(/-\d{8}-v\d+$/i, "");
  name = name.replace(/-v\d+$/i, "");
  name = name.replace(/-\d{8}$/, "");
  // Strip trailing ".v1" or similar Anthropic-on-Bedrock tails if present.
  name = name.replace(/\.v\d+$/i, "");
  return name || null;
}

// Read Kiro CLI requests using SQL-side json_extract so we don't pull the
// full (93 MB-ish) conversations_v2 blob back through sqlite3 -json.
//
// D-1: also surfaces `user_turn_metadata.continuation_id` so the cross-
// source retraction pass (parseKiroCliIncremental) can match whichever
// UUID kiro-cli used as the session link. The SQL column
// `conversation_id` and the inner JSON `continuation_id` are different
// UUIDs on observed data; covering both means retraction fires whichever
// side matches the live session's `session_id`.
function readKiroCliRequests(dbPath, env = process.env) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  let raw;
  try {
    raw = cp.execFileSync(
      "sqlite3",
      [
        "-json",
        dbPath,
        "SELECT conversation_id, " +
          "json_extract(value, '$.model_info.model_id') AS session_model_id, " +
          "json_extract(value, '$.user_turn_metadata.continuation_id') AS continuation_id, " +
          "json_extract(value, '$.user_turn_metadata.requests') AS requests_json " +
          "FROM conversations_v2 " +
          "WHERE json_extract(value, '$.user_turn_metadata.requests') IS NOT NULL",
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 120_000 },
    );
  } catch (err) {
    // TASK-012 / D-8: debug-gated stderr log so a missing sqlite3 binary
    // is distinguishable from an empty DB. Silent by default. env is
    // threaded so tests can toggle debug hermetically.
    const dbg = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
    if (dbg === "1" || dbg === "true") {
      process.stderr.write(
        `[kiro-cli] sqlite3 read failed: ${err?.message || err}\n`,
      );
    }
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const flat = [];
  for (const row of rows) {
    let requests;
    try {
      requests = JSON.parse(row.requests_json || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(requests)) continue;
    for (const r of requests) {
      if (!r || typeof r !== "object") continue;
      flat.push({
        conversation_id: row.conversation_id,
        continuation_id: row.continuation_id || null,
        session_model_id: row.session_model_id || null,
        request_id: r.request_id || null,
        message_id: r.message_id || null,
        user_prompt_length: r.user_prompt_length,
        response_size: r.response_size,
        model_id: r.model_id || null,
        request_start_timestamp_ms: r.request_start_timestamp_ms,
      });
    }
  }
  return flat;
}

async function parseKiroCliIncremental({ sessionFiles, cursors, queuePath, onProgress, env } = {}) {
  await ensureDir(path.dirname(queuePath));
  const kiroCliState =
    cursors.kiroCli && typeof cursors.kiroCli === "object" ? cursors.kiroCli : {};
  const seenIds = new Set(Array.isArray(kiroCliState.seenIds) ? kiroCliState.seenIds : []);

  // Back-compat branch: if caller explicitly passes sessionFiles (an array of
  // per-session .json paths, the old contract used in tests/fixtures), read
  // them as user_turn_metadatas. New default path below reads the SQLite DB.
  if (Array.isArray(sessionFiles)) {
    return parseKiroCliFromSessionFiles({
      sessionFiles,
      cursors,
      queuePath,
      onProgress,
      env,
      kiroCliState,
      seenIds,
    });
  }

  const resolvedEnv = env || process.env;
  const dbPath = resolveKiroCliDbPath(resolvedEnv);

  // Combine two sources under the same (source='kiro', cursors.kiroCli)
  // namespace: historical rows from the SQLite DB plus live session state
  // from ~/.kiro/sessions/cli/{uuid}.json (covers turns from a running
  // session that hasn't flushed to SQLite yet). Request ID shapes differ:
  // SQLite carries a persisted request_id UUID; session files synthesize
  // `${sessionId}:${loop_id.rand}`. When kiro-cli migrates a live session
  // into SQLite the same turn lands under a new request_id — the cross-
  // source retraction pass below (D-1 + TASK-007) matches session_id ↔
  // SQLite conversation_id OR continuation_id to subtract the orphan
  // session-file cursor entry before the new SQLite row is processed.
  const flatDb = fssync.existsSync(dbPath)
    ? readKiroCliRequests(dbPath, resolvedEnv)
    : [];
  const sessionFilesList = resolveKiroCliSessionFiles(resolvedEnv);
  let flatSessions = [];
  for (const jsonPath of sessionFilesList) {
    const turns = await readKiroCliSessionTurns(jsonPath);
    for (const turn of turns) flatSessions.push(turn);
  }
  // Per-request state replaces the old seenIds set. Each entry captures
  // what we contributed for that request_id last time, so a later mutation
  // (same request_id, different fingerprint) can subtract-old/add-new
  // instead of being skipped forever.
  const requestState =
    kiroCliState.requests && typeof kiroCliState.requests === "object"
      ? { ...kiroCliState.requests }
      : {};

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const debugEnabled = ["1", "true"].includes(
    String(resolvedEnv.TOKENTRACKER_DEBUG || "").toLowerCase(),
  );

  // ── TASK-007 + D-1: cross-source retraction. When a conversation has
  //    migrated from the session-file tier into SQLite, the cursor's
  //    prior session-file entry (keyed `${sessionId}:${loopRand}` OR a
  //    bare message_id UUID when loop_id is absent) never matches the
  //    new SQLite request_id. Without retraction the old contribution
  //    stays in the bucket absolute and the new SQLite row is added on
  //    top — permanent double-count. D-6: typed non-empty check so a
  //    corrupt NULL/empty conv_id can't poison the match set.
  const migratedConvIds = new Set();
  for (const row of flatDb) {
    if (!row) continue;
    if (typeof row.conversation_id === "string" && row.conversation_id)
      migratedConvIds.add(row.conversation_id);
    if (typeof row.continuation_id === "string" && row.continuation_id)
      migratedConvIds.add(row.continuation_id);
  }
  if (migratedConvIds.size > 0) {
    // Pre-collect to retract so mutation during iteration is safe.
    const toRetract = [];
    for (const [reqId, prev] of Object.entries(requestState)) {
      if (!prev || typeof prev !== "object") continue;
      // Bug-2: prefer the stored session_id tag (new schema); fall back
      // to colon-split for legacy cursors pre-dating this change.
      let sid = null;
      if (typeof prev.session_id === "string" && prev.session_id) {
        sid = prev.session_id;
      } else {
        const colon = reqId.indexOf(":");
        if (colon > 0) sid = reqId.slice(0, colon);
      }
      if (!sid || !migratedConvIds.has(sid)) continue;
      toRetract.push([reqId, prev, sid]);
    }
    for (const [reqId, prev, sid] of toRetract) {
      if (prev.input_tokens || prev.output_tokens) {
        const prevBucket = getHourlyBucket(
          hourlyState,
          "kiro",
          prev.model,
          prev.bucketStart,
        );
        addTotals(prevBucket.totals, {
          input_tokens: -prev.input_tokens,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: -prev.output_tokens,
          reasoning_output_tokens: 0,
          total_tokens: -(prev.input_tokens + prev.output_tokens),
          conversation_count: -1,
        });
        touchedBuckets.add(bucketKey("kiro", prev.model, prev.bucketStart));
      }
      delete requestState[reqId];
      if (debugEnabled) {
        process.stderr.write(
          `[kiro-cli] retracted migrated session entry (conv ${sid})\n`,
        );
      }
    }
    // D-14: drop matching session-file entries from this run via filter
    // (O(N)) instead of reverse-splice-in-loop (O(N²)).
    const before = flatSessions.length;
    flatSessions = flatSessions.filter((s) => {
      if (!s) return false;
      let sid = null;
      if (typeof s.session_id === "string" && s.session_id) {
        sid = s.session_id;
      } else {
        const rid = s.request_id || "";
        const colon = rid.indexOf(":");
        if (colon > 0) sid = rid.slice(0, colon);
      }
      return !(sid && migratedConvIds.has(sid));
    });
    if (debugEnabled && flatSessions.length !== before) {
      process.stderr.write(
        `[kiro-cli] dropped ${before - flatSessions.length} migrated session-file turn(s)\n`,
      );
    }
  }

  const flat = flatDb.concat(flatSessions);

  if (flat.length === 0) {
    // Bug-1: retraction may have touched buckets even with empty flat.
    // Clamp + cap BEFORE flushing so the early-return path applies the
    // same guarantees as the main path (fixes a skip that flushed
    // negative conversation_counts and left the cap unapplied).
    const cappedEarly = clampAndCapKiroCliState({
      requestState,
      hourlyState,
      touchedBuckets,
    });
    const bucketsQueued = await enqueueTouchedBuckets({
      queuePath,
      hourlyState,
      touchedBuckets,
    });
    const updatedAt = new Date().toISOString();
    hourlyState.updatedAt = updatedAt;
    cursors.hourly = hourlyState;
    cursors.kiroCli = { ...kiroCliState, requests: cappedEarly, updatedAt };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued };
  }
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let i = 0; i < flat.length; i++) {
    const r = flat[i];
    recordsProcessed++;

    const requestId = r.request_id || r.message_id;
    if (!requestId) continue;

    const promptChars = toNonNegativeInt(r.user_prompt_length);
    const responseChars = toNonNegativeInt(r.response_size);
    const approxInput = Math.floor(promptChars / KIRO_CLI_CHARS_PER_TOKEN);
    const approxOutput = Math.floor(responseChars / KIRO_CLI_CHARS_PER_TOKEN);

    const tsMs = Number(r.request_start_timestamp_ms);
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;
    const bucketStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
    if (!bucketStart) continue;

    const rawModel = r.model_id || r.session_model_id;
    const canonical = canonicalizeKiroCliModelId(rawModel);
    const model = canonical || "kiro-cli-agent";

    // Fingerprint captures every field whose change should cause a re-bucket.
    const fingerprint = `${promptChars}:${responseChars}:${model}:${tsMs}`;
    const prev = requestState[requestId];
    if (prev && prev.fingerprint === fingerprint) continue; // unchanged

    // Subtract the prior contribution (if any) from its prior bucket so the
    // bucket's absolute totals reflect the CURRENT truth, not the historical
    // truth. enqueueTouchedBuckets will emit the net delta at flush time.
    if (prev && (prev.input_tokens || prev.output_tokens)) {
      const prevBucket = getHourlyBucket(hourlyState, "kiro", prev.model, prev.bucketStart);
      addTotals(prevBucket.totals, {
        input_tokens: -prev.input_tokens,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: -prev.output_tokens,
        reasoning_output_tokens: 0,
        total_tokens: -(prev.input_tokens + prev.output_tokens),
        conversation_count: -1,
      });
      touchedBuckets.add(bucketKey("kiro", prev.model, prev.bucketStart));
    }

    // Add the new contribution.
    if (approxInput > 0 || approxOutput > 0) {
      const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
      addTotals(bucket.totals, {
        input_tokens: approxInput,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: approxOutput,
        reasoning_output_tokens: 0,
        total_tokens: approxInput + approxOutput,
        conversation_count: 1,
      });
      touchedBuckets.add(bucketKey("kiro", model, bucketStart));
      eventsAggregated++;
    }

    // Always record the cursor entry (even for zero-token requests) so we
    // don't re-count later if Kiro rewrites this request with real data.
    // Bug-2: tag session-origin entries with session_id so the retraction
    // pass can identify them regardless of request_id format (the
    // no-loop_id fallback produces a bare UUID with no colon, which would
    // otherwise be indistinguishable from SQLite's UUID keys).
    requestState[requestId] = {
      fingerprint,
      bucketStart,
      model,
      input_tokens: approxInput,
      output_tokens: approxOutput,
      ...(r.session_id ? { session_id: r.session_id } : {}),
    };

    if (cb && i % 50 === 0) {
      cb({
        index: i + 1,
        total: flat.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const cappedState = clampAndCapKiroCliState({
    requestState,
    hourlyState,
    touchedBuckets,
  });

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiroCli = { ...kiroCliState, requests: cappedState, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// TASK-004 + TASK-010 + Bug-1: shared end-of-run clamp + cap for
// parseKiroCliIncremental. Centralized so the main path AND the
// retraction-only early-return path both apply the same guarantees.
// Mutates hourlyState bucket totals in place (clamp) and returns a new
// capped requestState object (cap).
const KIRO_CLI_CURSOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const KIRO_CLI_CURSOR_MAX_ENTRIES = 20_000;

function clampAndCapKiroCliState({ requestState, hourlyState, touchedBuckets }) {
  // TASK-010: clamp conversation_count to >= 0 on Kiro-touched buckets
  // only. The shared enqueueTouchedBuckets is left untouched so
  // legitimate negatives from the 10 other parsers are not masked. Kiro
  // negatives come from the subtract-old pass on mutation or retraction.
  for (const key of touchedBuckets) {
    const bucket = hourlyState.buckets && hourlyState.buckets[key];
    if (bucket && bucket.totals && bucket.totals.conversation_count < 0) {
      bucket.totals.conversation_count = 0;
    }
  }
  // TASK-004: cap cursors.kiroCli.requests by age + count. Runs LAST so
  // nothing active or just-retracted is pruned mid-flight.
  const ageCutoffMs = Date.now() - KIRO_CLI_CURSOR_MAX_AGE_MS;
  const cappedEntries = [];
  for (const [reqId, entry] of Object.entries(requestState)) {
    if (!entry || typeof entry !== "object") continue;
    const ts = entry.bucketStart ? Date.parse(entry.bucketStart) : NaN;
    if (!Number.isFinite(ts) || ts < ageCutoffMs) continue;
    cappedEntries.push([reqId, entry, ts]);
  }
  if (cappedEntries.length > KIRO_CLI_CURSOR_MAX_ENTRIES) {
    cappedEntries.sort((a, b) => b[2] - a[2]); // newest first
    cappedEntries.length = KIRO_CLI_CURSOR_MAX_ENTRIES;
  }
  const capped = {};
  for (const [reqId, entry] of cappedEntries) capped[reqId] = entry;
  return capped;
}

// Back-compat path: per-session .json files (the old fixture shape). Emits
// exact tokens if the fixture happens to carry them (which the test fixture
// does). Used only by the test/rollout-parser.test.js fixture tests.
async function parseKiroCliFromSessionFiles({
  sessionFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  kiroCliState,
  seenIds,
}) {
  const fileOffsets =
    kiroCliState.fileOffsets && typeof kiroCliState.fileOffsets === "object"
      ? { ...kiroCliState.fileOffsets }
      : {};
  if (sessionFiles.length === 0) {
    cursors.kiroCli = {
      ...kiroCliState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < sessionFiles.length; fileIdx++) {
    const filePath = sessionFiles[fileIdx];
    let stat;
    try {
      stat = fssync.statSync(filePath);
    } catch {
      continue;
    }

    const prevEntry = fileOffsets[filePath] || {};
    const prevMtime = Number(prevEntry.mtimeMs) || 0;
    const prevLastIndex = Number.isFinite(Number(prevEntry.lastIndex))
      ? Number(prevEntry.lastIndex)
      : -1;
    if (prevMtime && stat.mtimeMs <= prevMtime) continue;

    let parsed;
    try {
      parsed = JSON.parse(fssync.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const turns = Array.isArray(
      parsed?.session_state?.conversation_metadata?.user_turn_metadatas,
    )
      ? parsed.session_state.conversation_metadata.user_turn_metadatas
      : [];
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : filePath;
    const sessionModelId =
      (parsed?.session_state?.rts_model_state?.model_info &&
        (parsed.session_state.rts_model_state.model_info.model_id ||
          parsed.session_state.rts_model_state.model_info.modelId)) ||
      null;

    let maxIndex = prevLastIndex;
    for (let i = 0; i < turns.length; i++) {
      if (i <= prevLastIndex) continue;
      const turn = turns[i];
      if (!turn || typeof turn !== "object") continue;
      recordsProcessed++;

      const input = toNonNegativeInt(turn.input_tokens);
      const output = toNonNegativeInt(turn.output_tokens);
      const cacheRead = toNonNegativeInt(
        turn.cache_read_input_tokens ?? turn.cached_input_tokens,
      );
      const cacheCreation = toNonNegativeInt(
        turn.cache_creation_input_tokens ?? turn.cache_write_input_tokens,
      );
      const reasoning = toNonNegativeInt(turn.reasoning_output_tokens);
      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
        maxIndex = i;
        continue;
      }

      const ts = turn.timestamp || turn.created_at || turn.updated_at;
      if (!ts) continue;
      const bucketStart = toUtcHalfHourStart(ts);
      if (!bucketStart) continue;

      const turnMessageId =
        typeof turn.message_id === "string" && turn.message_id ? turn.message_id : null;
      const dedupKey = turnMessageId ? `${sessionId}:${turnMessageId}` : null;
      if (dedupKey && seenIds.has(dedupKey)) {
        maxIndex = i;
        continue;
      }

      const rawModel =
        turn.model_id ||
        turn.modelId ||
        (turn.model_info && (turn.model_info.model_id || turn.model_info.modelId)) ||
        sessionModelId;
      const normalized = rawModel ? normalizeKiroModelName(rawModel) : null;
      const model = normalized || "kiro-cli-agent";

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output + cacheRead + cacheCreation + reasoning,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kiro", model, bucketStart));
      if (dedupKey) seenIds.add(dedupKey);
      maxIndex = i;
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: sessionFiles.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    fileOffsets[filePath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastIndex: maxIndex,
    };
  }

  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiroCli = { ...kiroCliState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────

function resolveKimiWireFiles(env = process.env) {
  const home = require("node:os").homedir();
  const kimiHome = env.KIMI_HOME || path.join(home, ".kimi");
  const sessionsDir = path.join(kimiHome, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  try {
    for (const ws of fssync.readdirSync(sessionsDir)) {
      const wsDir = path.join(sessionsDir, ws);
      let wsStat;
      try { wsStat = fssync.statSync(wsDir); } catch { continue; }
      if (!wsStat.isDirectory()) continue;
      for (const sess of fssync.readdirSync(wsDir)) {
        const wireFile = path.join(wsDir, sess, "wire.jsonl");
        if (fssync.existsSync(wireFile)) files.push(wireFile);
      }
    }
  } catch { /* ignore */ }
  return files;
}

async function parseKimiIncremental({ wireFiles, cursors, queuePath, onProgress, env, model } = {}) {
  await ensureDir(path.dirname(queuePath));
  const kimiState = cursors.kimi && typeof cursors.kimi === "object" ? cursors.kimi : {};
  const seenIds = new Set(Array.isArray(kimiState.seenIds) ? kimiState.seenIds : []);
  const fileOffsets =
    kimiState.fileOffsets && typeof kimiState.fileOffsets === "object"
      ? { ...kimiState.fileOffsets }
      : {};

  const files = Array.isArray(wireFiles)
    ? wireFiles
    : resolveKimiWireFiles(env || process.env);
  const kimiModel = model || resolveKimiDefaultModel(env || process.env);
  if (files.length === 0) {
    cursors.kimi = { ...kimiState, seenIds: Array.from(seenIds), fileOffsets, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const msg = entry.message;
      if (!msg || msg.type !== "StatusUpdate") continue;

      const payload = msg.payload;
      if (!payload) continue;
      const { token_usage, message_id } = payload;
      if (!token_usage || !message_id) continue;
      if (seenIds.has(message_id)) continue;

      recordsProcessed++;

      const input = toNonNegativeInt(token_usage.input_other);
      const output = toNonNegativeInt(token_usage.output);
      const cacheRead = toNonNegativeInt(token_usage.input_cache_read);
      const cacheCreation = toNonNegativeInt(token_usage.input_cache_creation);
      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
        seenIds.add(message_id);
        continue;
      }

      const epochSec = entry.timestamp ?? payload.timestamp;
      if (epochSec == null || !Number.isFinite(Number(epochSec))) continue;
      const tsIso = new Date(Number(epochSec) * 1000).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output + cacheRead + cacheCreation,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "kimi", kimiModel, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kimi", kimiModel, bucketStart));
      seenIds.add(message_id);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = { size: postStat.size, mtimeMs: postStat.mtimeMs, ino: postStat.ino };
  }

  // Cap seenIds to last 10k to bound cursor state size
  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kimi = { ...kimiState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot CLI — OpenTelemetry JSONL exporter
// User must opt in by setting:
//   COPILOT_OTEL_ENABLED=true
//   COPILOT_OTEL_EXPORTER_TYPE=file
//   COPILOT_OTEL_FILE_EXPORTER_PATH=$HOME/.copilot/otel/copilot-otel-...jsonl
// We scan the default directory plus the env-overridden path.
// ─────────────────────────────────────────────────────────────────────────────

function resolveCopilotOtelPaths(env = process.env) {
  const home = require("node:os").homedir();
  const paths = new Set();
  const defaultDir = path.join(home, ".copilot", "otel");
  if (fssync.existsSync(defaultDir)) {
    try {
      for (const entry of fssync.readdirSync(defaultDir)) {
        if (entry.endsWith(".jsonl")) paths.add(path.join(defaultDir, entry));
      }
    } catch (_e) {}
  }
  const explicit = env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof explicit === "string" && explicit.trim() && fssync.existsSync(explicit)) {
    paths.add(explicit);
  }
  return Array.from(paths).sort();
}

function isCopilotChatSpan(record) {
  if (!record || record.type !== "span") return false;
  const opName = record?.attributes?.["gen_ai.operation.name"];
  if (opName === "chat") return true;
  if (typeof record.name === "string" && record.name.startsWith("chat ")) return true;
  return false;
}

function copilotOtelTimeToMs(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const seconds = Number(value[0]);
  const nanos = Number(value[1]);
  if (!Number.isFinite(seconds)) return null;
  const ns = Number.isFinite(nanos) ? nanos : 0;
  return Math.round(seconds * 1000 + ns / 1_000_000);
}

function pickCopilotModel(attrs) {
  const candidates = [attrs?.["gen_ai.response.model"], attrs?.["gen_ai.request.model"]];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

async function parseCopilotIncremental({ otelPaths, cursors, queuePath, onProgress, env } = {}) {
  await ensureDir(path.dirname(queuePath));
  const copilotState = cursors.copilot && typeof cursors.copilot === "object" ? cursors.copilot : {};
  const seenIds = new Set(Array.isArray(copilotState.seenIds) ? copilotState.seenIds : []);
  const fileOffsets =
    copilotState.fileOffsets && typeof copilotState.fileOffsets === "object"
      ? { ...copilotState.fileOffsets }
      : {};

  const files = Array.isArray(otelPaths) && otelPaths.length > 0
    ? otelPaths
    : resolveCopilotOtelPaths(env || process.env);
  if (files.length === 0) {
    cursors.copilot = { ...copilotState, seenIds: Array.from(seenIds), fileOffsets, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try {
      stat = fssync.statSync(filePath);
    } catch (_e) {
      continue;
    }
    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    // Re-read from start if (a) file shrunk (truncate/rewrite in place) or
    // (b) inode changed (rotator deleted + recreated at same path). Without
    // the inode check, a rotator producing a same-or-larger file would leave
    // the old offset stuck and skip the new file's prefix forever.
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
    } catch (_e) {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      recordsProcessed++;
      if (!isCopilotChatSpan(record)) continue;

      const traceId = record?.traceId || "";
      const spanId = record?.spanId || "";
      const dedupKey = traceId && spanId ? `${traceId}:${spanId}` : null;
      if (dedupKey && seenIds.has(dedupKey)) continue;

      const attrs = record.attributes || {};
      const inputRaw = toNonNegativeInt(attrs["gen_ai.usage.input_tokens"]);
      const output = toNonNegativeInt(attrs["gen_ai.usage.output_tokens"]);
      const cacheRead = toNonNegativeInt(attrs["gen_ai.usage.cache_read.input_tokens"]);
      const cacheWrite = toNonNegativeInt(attrs["gen_ai.usage.cache_write.input_tokens"]);
      const reasoning = toNonNegativeInt(attrs["gen_ai.usage.reasoning.output_tokens"]);
      // OTEL input_tokens INCLUDES cache_read — subtract per project convention
      const cacheReadClamped = Math.min(cacheRead, inputRaw);
      const input = Math.max(0, inputRaw - cacheReadClamped);
      const totalInteresting = input + output + cacheReadClamped + cacheWrite + reasoning;
      // Drop empty rows unless cache-only
      if (totalInteresting === 0) continue;

      const tsMs = copilotOtelTimeToMs(record.endTime) || copilotOtelTimeToMs(record.startTime);
      if (!tsMs) continue;
      const tsIso = new Date(tsMs).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const model = normalizeModelInput(pickCopilotModel(attrs)) || "github-copilot";

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheReadClamped,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output + cacheReadClamped + cacheWrite + reasoning,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "copilot", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("copilot", model, bucketStart));
      eventsAggregated++;
      if (dedupKey) seenIds.add(dedupKey);

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    // Re-stat after readline drains: file may have been appended during the
    // parse loop. Without this, those new lines would be replayed next run
    // (dedup catches records with traceId+spanId, but spans missing either
    // would be double-counted).
    let postStat = stat;
    try {
      postStat = fssync.statSync(filePath);
    } catch (_e) {}
    fileOffsets[filePath] = { size: postStat.size, mtimeMs: postStat.mtimeMs, ino: postStat.ino };
  }

  // Cap dedup set to last 10k IDs to bound state size
  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.copilot = { ...copilotState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

module.exports = {
  listRolloutFiles,
  listClaudeProjectFiles,
  listGeminiSessionFiles,
  listOpencodeMessageFiles,
  readOpencodeDbMessages,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
  resolveHermesDbPath,
  resolveCopilotOtelPaths,
  parseRolloutIncremental,
  parseClaudeIncremental,
  parseGeminiIncremental,
  parseOpencodeIncremental,
  parseOpencodeDbIncremental,
  parseOpenclawIncremental,
  parseCursorApiIncremental,
  parseKiroIncremental,
  parseHermesIncremental,
  parseCopilotIncremental,
  resolveKimiWireFiles,
  resolveKimiDefaultModel,
  parseKimiIncremental,
  resolveKiroCliSessionFiles,
  resolveKiroCliDbPath,
  parseKiroCliIncremental,
  // Exposed for regression tests covering cache-token accounting.
  normalizeGeminiTokens,
  normalizeOpencodeTokens,
  sameGeminiTotals,
  diffGeminiTotals,
};
