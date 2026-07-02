const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const cp = require("node:child_process");
const readline = require("node:readline");

const { ensureDir, readJson, writeJson, openLock } = require("../lib/fs");
const {
  listRolloutFiles,
  listRolloutFilesDeep,
  codexSessionIdFromPath,
  filterColdCodexRolloutFiles,
  listClaudeProjectFiles,
  listGeminiSessionFiles,
  listOpencodeMessageFiles,
  readOpencodeDbMessages,
  readMimoDbMessages,
  readZcodeDbMessages,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
  resolveHermesPath,
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
  parseKimiIncremental,
  resolveKimiCodeWireFiles,
  parseKimiCodeIncremental,
  resolveOmpSessionFiles,
  parseOmpIncremental,
  resolvePiSessionFiles,
  parsePiIncremental,
  piAgentDirCollidesWithOmp,
  resolveCraftSessionFiles,
  parseCraftIncremental,
  resolveGrokBuildSessions,
  parseGrokBuildIncremental,
  listAntigravityTranscripts,
  parseAntigravityIncremental,
  resolveCodebuddyProjectFiles,
  parseCodebuddyIncremental,
  resolveWorkbuddyProjectFiles,
  parseWorkbuddyIncremental,
  resolveKiroCliSessionFiles,
  resolveKiroCliDbPath,
  parseKiroCliIncremental,
  resolveKilocodeTaskFiles,
  parseKilocodeIncremental,
  resolveRoocodeTaskFiles,
  parseRoocodeIncremental,
  resolveZedDbPath,
  parseZedIncremental,
  resolveGooseDbPath,
  parseGooseIncremental,
  listDroidSettingsFiles,
  parseDroidIncremental,
  droidSessionIdFromPath,
  resolveDroidModel,
  bucketKey,
  toUtcHalfHourStart,
  totalsKey,
  claudeMessageDedupKey,
} = require("../lib/rollout");
const { computeClaudeGroundTruthBuckets } = require("../lib/claude-categorizer");
const { createProgress, renderBar, formatNumber, formatBytes } = require("../lib/progress");
const {
  normalizeState: normalizeUploadState,
  decideAutoUpload,
  recordUploadFailure,
  recordUploadSuccess,
  parseRetryAfterMs,
} = require("../lib/upload-throttle");
const {
  isCursorInstalled,
  extractCursorSessionToken,
  fetchCursorUsageCsv,
  parseCursorCsv,
} = require("../lib/cursor-config");
const { purgeProjectUsage } = require("../lib/project-usage-purge");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { resolveRuntimeConfig } = require("../lib/runtime-config");

const CURSOR_UNKNOWN_MIGRATION_KEY = "cursorUnknownPurge_2026_04";
const ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY = "rolloutCumulativeDeltaReparse_2026_05";
const CLAUDE_MEM_OBSERVER_REINCLUDE_KEY = "claudeMemObserverReinclude_2026_05_v3";
const GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY = "grokAppendOnlyRepair_2026_05_v4";
const CLAUDE_MEM_OBSERVER_PATH_SEGMENT = "--claude-mem-observer-sessions";
// v1 had a cursor-format bug (wrote plain integer instead of {inode, offset,
// updatedAt}), which made parseClaudeIncremental reread every jsonl from
// byte 0 on the next sync and double everything. v2 fixed the format.
// v3 fixes two latent issues caught by adversarial review:
//   (a) v2 wrote `cursors.hourly.groupQueued[claude|<hour>]` for every
//       repaired bucket. enqueueTouchedBuckets uses presence of that key
//       as the legacy-group marker, so any later sync that touched a
//       claude hour (even just a user-message conv-count++) would re-emit
//       the entire hour as one aggregate row under model=DEFAULT_MODEL,
//       causing a different inflation path. v3 leaves groupQueued alone.
//   (b) v2 only repaired the main queue.jsonl. project.queue.jsonl still
//       carried historical claude-mem observer rows (project_key=
//       "claude-mem/observer-sessions") and the project totals on the
//       Project Usage panel stayed inflated. v3 drops every claude /
//       claude-mem row from project.queue.jsonl too, and resets the
//       matching cursors.projectHourly + project.queue.state offset.
// v4 fixes the dedup short-circuit (issue #64): v3's ground-truth scan
// itself used `if (msgId && reqId)` to build the dedup key, which silently
// disabled dedup for any provider whose jsonl entries lack `requestId`
// (DeepSeek/Kimi/Mimo/MiniMax anthropic-compatible endpoints, plus Claude
// Code's sub-agent / thinking transport paths). The repaired ground truth
// was therefore inflated by 1.6–3.7x on those providers — v3 left it that
// way.
// v6 was bumped in 0.26.3 to re-run the repair with the zero-usage dedup fix
// applied. SHIPPING 0.26.3 caused catastrophic data loss on every upgrader
// whose ~/.claude session jsonls had been pruned by Claude Code's own
// cleanup: the repair does atomic-drop + rescan, so any hour_start no longer
// represented in the on-disk logs is silently removed from queue.jsonl. On
// the reporter's machine this wiped 2.17B claude tokens (-1.27B opus-4-7,
// -474M opus-4-6, -376M sonnet-4-5, -48M haiku, -6M sonnet-4-6). The
// upload-offset reset also propagated the damage to the cloud.
// 0.26.4 HALTS back at v4 so the buggy atomic-rewrite path stops auto-firing
// on existing installs. The dedup fixes in parseClaudeFile /
// categorizeSessionFile / computeClaudeGroundTruthBuckets are KEPT — they are
// correct in isolation, and any future repair will produce the right answer
// for whatever data is actually on disk. A targeted, log-gap-safe mimo
// migration will ship later under its own key.
const CLAUDE_GROUND_TRUTH_REPAIR_KEY = "claudeGroundTruthRepair_2026_05_v4";
// One-time full re-upload: the cloud ingest dropped `conversation_count` to 0
// from 2026-04-18 until the 2026-06-10 field-mapping fix (it read
// `b.conversations`; queue rows carry `conversation_count`). Historical cloud
// rows can only be repaired from each user's local queue.jsonl — resetting the
// upload offset replays the full queue and the ingest's whole-row upsert
// overwrites every historical bucket with the correct conversation counts
// (token columns replay to the same final values: last emission per key wins,
// exactly how the cloud rows were built the first time).
const CLOUD_CONVERSATIONS_BACKFILL_KEY = "cloudConversationsBackfill_2026_06";
// One-time repair (#187): until the codexHashes event-dedup landed, a Codex
// session file rewritten with a new inode (Codex-Manager atomically rewrites
// sessions/ files to patch the provider on every account switch) was re-scanned
// from offset 0 and its tokens re-added to the persistent hourly buckets. This
// rebuilds the codex buckets from disk (event-deduped), atomically drops the
// inflated codex rows from queue.jsonl, and resets the upload offset so the
// corrected values overwrite the cloud. GUARDED: skips if any codex session
// file that previously contributed is no longer on disk (deleted, or moved to
// ~/.codex/archived_sessions/ which sync does not scan) — clearing its bucket
// would lose that history (ref the v6 ground-truth-repair data-loss incident).
const CODEX_RESCAN_DEDUP_REPAIR_KEY = "codexRescanDedupRepair_2026_06";
const DROID_DUP_SESSION_REPAIR_KEY = "droidDupSessionInflationRepair_2026_06";
const CODEX_COLD_SCAN_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CODEX_COLD_SCAN_AUDIT_MAX_SYNCS = 288;
// 0.57.0 mis-attributed mimocode's mirrored Claude/claude-mem history to
// source=mimo (read the whole DB instead of only providerID=mimo rows). This
// one-time repair purges all source=mimo data from the local queues + cursor
// state so the next sync (providerID-filtered reader) rebuilds it correctly.
const MIMO_PROVIDER_REPAIR_KEY = "mimoClaudeMislabelRepair_2026_06";
const AUTO_SYNC_SOURCE_ALIASES = new Map([
  ["code", "every-code"],
  ["everycode", "every-code"],
  ["kilo", "kilo-cli"],
  ["kilo-code", "kilocode"],
  ["kimi_code", "kimi-code"],
  ["roo-code", "roocode"],
]);
const AUTO_SYNC_SOURCES = new Set([
  "antigravity",
  "claude",
  "codebuddy",
  "codex",
  "copilot",
  "craft",
  "cursor",
  "droid",
  "every-code",
  "gemini",
  "goose",
  "grok",
  "hermes",
  "kilo-cli",
  "kilocode",
  "kiro",
  "kimi",
  "kimi-code",
  "mimo",
  "omp",
  "opencode",
  "openclaw",
  "pi",
  "roocode",
  "workbuddy",
  "zcode",
  "zed",
]);

function warnProviderParseFailure(label, err, opts) {
  if (opts?.auto) return;
  process.stderr.write(`${label} sync: ${err && err.message ? err.message : err}\n`);
}

async function cmdSync(argv) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir } = await resolveTrackerPaths({ home });

  await ensureDir(trackerDir);
  if (opts.fromOpenclaw) {
    await writeOpenclawSignal(trackerDir);
  }

  const lockPath = path.join(trackerDir, "sync.lock");
  const lock = await openLock(lockPath, { quietIfLocked: opts.auto });
  if (!lock) return;

  let progress = null;
  try {
    progress = !opts.auto ? createProgress({ stream: process.stdout }) : null;
    const configPath = path.join(trackerDir, "config.json");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const projectQueueStatePath = path.join(trackerDir, "project.queue.state.json");
    const uploadThrottlePath = path.join(trackerDir, "upload.throttle.json");
    const grokSignalPath = path.join(trackerDir, "grok-last-session.json");
    const legacyGrokSignalPath = path.join(trackerDir, "tracker", "grok-last-session.json");

    const config = await readJson(configPath);
    const cursors = (await readJson(cursorsPath)) || { version: 1, files: {}, updatedAt: null };
    const uploadThrottle = normalizeUploadState(await readJson(uploadThrottlePath));
    let uploadThrottleState = uploadThrottle;
    let grokHookSignal = null;
    let grokHookSignalPath = null;
    for (const candidate of [grokSignalPath, legacyGrokSignalPath]) {
      const signal = await readJson(candidate);
      if (signal && typeof signal === "object") {
        grokHookSignal = signal;
        grokHookSignalPath = candidate;
        break;
      }
    }
    let grokHookSignalConsumed = false;

    const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
    const codeHome = process.env.CODE_HOME || path.join(home, ".code");
    const claudeProjectsDir = path.join(home, ".claude", "projects");
    const geminiHome = process.env.GEMINI_HOME || path.join(home, ".gemini");
    const geminiTmpDir = path.join(geminiHome, "tmp");
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const opencodeHome = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
    const opencodeStorageDir = path.join(opencodeHome, "storage");
    const kiloHome = process.env.KILO_HOME || path.join(xdgDataHome, "kilo");
    const mimoHome = process.env.MIMO_HOME || path.join(xdgDataHome, "mimocode");
    const zcodeHome = process.env.ZCODE_HOME || path.join(home, ".zcode");

    // OpenClaw session plugin integration: lifecycle hooks request an
    // OpenClaw-only auto sync so unrelated providers do not get walked.
    const openclawSignal = opts.fromOpenclaw
      ? resolveOpenclawSignal({ home, env: process.env })
      : null;

    const autoSourceScope = resolveAutoSourceScope(opts);
    const isFullSourceScan = !autoSourceScope;
    const sourceAllowed = (...sources) =>
      !autoSourceScope || sources.includes(autoSourceScope);

    const sources = [];
    if (sourceAllowed("codex")) {
      sources.push(
        { source: "codex", sessionsDir: path.join(codexHome, "sessions"), codexInventoryCache: true },
        // Codex-Manager archives sessions to ~/.codex/archived_sessions/ on every
        // account/channel switch (issue #187). Scanning it too keeps that usage
        // counted instead of orphaning it in the cloud (a re-upload's upsert can
        // never delete cloud rows whose local source file has vanished). Safe
        // against double-counting: the codex event dedup keys on sessionUUID (in
        // the filename) + event timestamp, both stable across a sessions/ ->
        // archived_sessions/ move, so re-reading an archived copy is a no-op.
        { source: "codex", sessionsDir: path.join(codexHome, "archived_sessions"), deep: true },
      );
    }
    if (sourceAllowed("every-code")) {
      sources.push({ source: "every-code", sessionsDir: path.join(codeHome, "sessions") });
    }

    const rolloutFiles = [];
    const seenSessions = new Set();
    const codexDayInventoryCache =
      cursors.codexDayInventoryCache && typeof cursors.codexDayInventoryCache === "object"
        ? cursors.codexDayInventoryCache
        : { version: 1, days: {} };
    if (sourceAllowed("codex")) cursors.codexDayInventoryCache = codexDayInventoryCache;
    for (const entry of sources) {
      if (seenSessions.has(entry.sessionsDir)) continue;
      seenSessions.add(entry.sessionsDir);
      const files = entry.deep
        ? await listRolloutFilesDeep(entry.sessionsDir)
        : await listRolloutFiles(entry.sessionsDir, entry.codexInventoryCache
          ? { dayInventoryCache: codexDayInventoryCache }
          : undefined);
      for (const filePath of files) {
        rolloutFiles.push({ path: filePath, source: entry.source });
      }
    }

    if (isFullSourceScan) {
      await migrateRolloutCumulativeDeltaBuckets({ cursors, queuePath, rolloutFiles });
      await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles,
      });
      await repairDroidDuplicateSessionInflation({ cursors, queuePath, queueStatePath });
      await repairMimoClaudeMislabel({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
      });
    }

    const codexColdSkipEnabled = opts.auto && isFullSourceScan && sourceAllowed("codex");
    const codexColdAuditDue = codexColdSkipEnabled
      ? isCodexColdScanAuditDue(cursors)
      : false;
    const codexColdFilter = codexColdSkipEnabled
      ? await filterColdCodexRolloutFiles({
          rolloutFiles,
          cursors,
          projectEnabled: true,
          auditDue: codexColdAuditDue,
        })
      : { rolloutFiles, skipped: 0 };
    const rolloutFilesForParse = codexColdFilter.rolloutFiles;

    const openclawFiles = openclawSignal?.sessionFile
      ? [{ path: openclawSignal.sessionFile, source: "openclaw" }]
      : [];

    if (progress?.enabled) {
      progress.start(
        `Parsing ${renderBar(0)} 0/${formatNumber(rolloutFilesForParse.length)} files | buckets 0`,
      );
    }

    let parseResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    let codexParseSucceeded = false;
    try {
      parseResult = await parseRolloutIncremental({
        rolloutFiles: rolloutFilesForParse,
        cursors,
        queuePath,
        projectQueuePath,
        onProgress: (p) => {
          if (!progress?.enabled) return;
          const pct = p.total > 0 ? p.index / p.total : 1;
          progress.update(
            `Parsing ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
              p.bucketsQueued,
            )}`,
          );
        },
      });
      codexParseSucceeded = true;
    } catch (err) {
      warnProviderParseFailure("Codex", err, opts);
    }
    if (codexColdSkipEnabled && codexParseSucceeded) {
      recordCodexColdScanAudit(cursors, {
        fullAudit: codexColdAuditDue,
        skipped: codexColdFilter.skipped,
      });
    }

    let openclawResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("openclaw") && openclawFiles.length > 0) {
      // Only runs when explicitly triggered by the OpenClaw session plugin.
      try {
        openclawResult = await parseOpenclawIncremental({
          sessionFiles: openclawFiles,
          cursors,
          queuePath,
          projectQueuePath,
          source: "openclaw",
        });
      } catch (err) {
        warnProviderParseFailure("OpenClaw", err, opts);
      }
    }

    let openclawFallback = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("openclaw")) {
      try {
        openclawFallback = await applyOpenclawTotalsFallback({
          trackerDir,
          signal: openclawSignal,
          cursors,
          queuePath,
          projectQueuePath,
        });
      } catch (err) {
        warnProviderParseFailure("OpenClaw", err, opts);
      }
    }
    openclawResult.filesProcessed += openclawFallback.filesProcessed;
    openclawResult.eventsAggregated += openclawFallback.eventsAggregated;
    openclawResult.bucketsQueued += openclawFallback.bucketsQueued;

    const claudeFiles = sourceAllowed("claude") ? await listClaudeProjectFiles(claudeProjectsDir) : [];
    if (isFullSourceScan) {
      await reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath, queueStatePath });
      await repairClaudeQueueFromGroundTruth({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
      });
    }
    let claudeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (claudeFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Claude ${renderBar(0)} 0/${formatNumber(claudeFiles.length)} files | buckets 0`,
        );
      }
      try {
        claudeResult = await parseClaudeIncremental({
          projectFiles: claudeFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Claude ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "claude",
        });
      } catch (err) {
        warnProviderParseFailure("Claude", err, opts);
      }
    }

    const geminiFiles = sourceAllowed("gemini") ? await listGeminiSessionFiles(geminiTmpDir) : [];
    let geminiResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (geminiFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Gemini ${renderBar(0)} 0/${formatNumber(geminiFiles.length)} files | buckets 0`,
        );
      }
      try {
        geminiResult = await parseGeminiIncremental({
          sessionFiles: geminiFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Gemini ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "gemini",
        });
      } catch (err) {
        warnProviderParseFailure("Gemini", err, opts);
      }
    }

    const antigravityFiles = sourceAllowed("antigravity") ? await listAntigravityTranscripts(geminiHome) : [];
    let antigravityResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (antigravityFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Antigravity ${renderBar(0)} 0/${formatNumber(antigravityFiles.length)} files | buckets 0`,
        );
      }
      try {
        antigravityResult = await parseAntigravityIncremental({
          sessionFiles: antigravityFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Antigravity ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "antigravity",
        });
      } catch (err) {
        warnProviderParseFailure("Antigravity", err, opts);
      }
    }

    const opencodeFiles = sourceAllowed("opencode") ? await listOpencodeMessageFiles(opencodeStorageDir) : [];
    let opencodeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (opencodeFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Opencode ${renderBar(0)} 0/${formatNumber(opencodeFiles.length)} files | buckets 0`,
        );
      }
      try {
        opencodeResult = await parseOpencodeIncremental({
          messageFiles: opencodeFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Opencode ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
          source: "opencode",
        });
      } catch (err) {
        warnProviderParseFailure("Opencode", err, opts);
      }
    }

    // OpenCode v1.2+ stores messages in SQLite (opencode.db) instead of JSON files.
    const opencodeDbPath = path.join(opencodeHome, "opencode.db");
    let opencodeDbResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const dbMessages = sourceAllowed("opencode") ? readOpencodeDbMessages(opencodeDbPath) : [];
    if (dbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Opencode DB ${renderBar(0)} 0/${formatNumber(dbMessages.length)} msgs | buckets 0`,
        );
      }
      try {
        opencodeDbResult = await parseOpencodeDbIncremental({
          dbMessages,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Opencode DB ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} msgs | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
          source: "opencode",
        });
      } catch (err) {
        warnProviderParseFailure("Opencode DB", err, opts);
      }
      opencodeResult.filesProcessed += opencodeDbResult.messagesProcessed;
      opencodeResult.eventsAggregated += opencodeDbResult.eventsAggregated;
      opencodeResult.bucketsQueued += opencodeDbResult.bucketsQueued;
    }

    // ── Kilo CLI (kilo.ai @kilocode/plugin — OpenCode-fork SQLite) ──
    // Uses the exact same `message` table schema as OpenCode v1.2+. We reuse
    // the OpenCode DB reader/parser, just with a separate cursor namespace so
    // the message indexes don't collide.
    const kiloDbPath = path.join(kiloHome, "kilo.db");
    let kiloResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kiloDbMessages = sourceAllowed("kilo-cli") ? readOpencodeDbMessages(kiloDbPath) : [];
    if (kiloDbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Kilo CLI ${renderBar(0)} 0/${formatNumber(kiloDbMessages.length)} msgs | buckets 0`,
        );
      }
      try {
        kiloResult = await parseOpencodeDbIncremental({
          dbMessages: kiloDbMessages,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kilo CLI ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} msgs | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
          source: "kilo-cli",
          cursorKey: "kiloCli",
        });
      } catch (err) {
        warnProviderParseFailure("Kilo CLI", err, opts);
      }
    }

    // ── Mimo (mimocode — OpenCode-fork SQLite) ──
    // Xiaomi's Mimo code CLI is an OpenCode fork that stores assistant
    // messages in the exact same `message` table schema (mimocode.db). Reuse
    // the OpenCode parser with a dedicated cursor namespace so the message
    // indexes don't collide. readMimoDbMessages returns ONLY mimo's own-model
    // rows — mimocode mirrors the user's Claude Code + claude-mem history into
    // its DB (already counted as source=claude), so anything else would
    // double-count and mislabel Claude usage as mimo.
    const mimoDbPath = path.join(mimoHome, "mimocode.db");
    let mimoResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const mimoDbMessages = sourceAllowed("mimo") ? readMimoDbMessages(mimoDbPath) : [];
    if (mimoDbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Mimo ${renderBar(0)} 0/${formatNumber(mimoDbMessages.length)} msgs | buckets 0`,
        );
      }
      try {
        mimoResult = await parseOpencodeDbIncremental({
          dbMessages: mimoDbMessages,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Mimo ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} msgs | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
          source: "mimo",
          cursorKey: "mimo",
        });
      } catch (err) {
        warnProviderParseFailure("Mimo", err, opts);
      }
    }

    // ── ZCode (Z.ai's coding agent — OpenCode-fork SQLite) ──
    // Z.ai's ZCode CLI is an OpenCode fork that stores assistant messages in the
    // exact same `message` table schema (~/.zcode/cli/db/db.sqlite). Reuse the
    // OpenCode parser with a dedicated cursor namespace so the message indexes
    // don't collide. readZcodeDbMessages returns ONLY ZCode's own GLM rows
    // (providerID zai/bigmodel/zhipu) — ZCode can orchestrate bundled
    // claude-code/codex/gemini-cli sub-agents whose turns (anthropic/openai/
    // google) are already counted by the standalone parsers, so anything else
    // would double-count.
    const zcodeDbPath = path.join(zcodeHome, "cli", "db", "db.sqlite");
    let zcodeResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const zcodeDbMessages = sourceAllowed("zcode") ? readZcodeDbMessages(zcodeDbPath) : [];
    if (zcodeDbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing ZCode ${renderBar(0)} 0/${formatNumber(zcodeDbMessages.length)} msgs | buckets 0`,
        );
      }
      try {
        zcodeResult = await parseOpencodeDbIncremental({
          dbMessages: zcodeDbMessages,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing ZCode ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} msgs | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
          source: "zcode",
          cursorKey: "zcode",
        });
      } catch (err) {
        warnProviderParseFailure("ZCode", err, opts);
      }
    }

    // ── Kilo Code VS Code extension (Cline-style ui_messages.json) ──
    const kilocodeTaskFiles = sourceAllowed("kilocode") ? resolveKilocodeTaskFiles(process.env) : [];
    let kilocodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (kilocodeTaskFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Kilo Code ${renderBar(0)} 0/${formatNumber(kilocodeTaskFiles.length)} tasks | buckets 0`,
        );
      }
      try {
        kilocodeResult = await parseKilocodeIncremental({
          taskFiles: kilocodeTaskFiles,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kilo Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} tasks | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kilo Code", err, opts);
      }
    }

    // ── Goose (Block) — SQLite sessions with cumulative tokens per session ──
    const gooseDbPath = resolveGooseDbPath(process.env);
    let gooseResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("goose") && gooseDbPath && fssync.existsSync(gooseDbPath)) {
      if (progress?.enabled) {
        progress.start(`Parsing Goose ${renderBar(0)} 0 sessions | buckets 0`);
      }
      try {
        gooseResult = await parseGooseIncremental({
          dbPath: gooseDbPath,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Goose ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Goose", err, opts);
      }
    }

    // ── Droid (Factory CLI) — passive reader for ~/.factory/sessions/*.settings.json ──
    const droidSettingsFiles = sourceAllowed("droid") ? listDroidSettingsFiles(process.env) : [];
    let droidResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (droidSettingsFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Droid ${renderBar(0)} 0/${formatNumber(droidSettingsFiles.length)} sessions | buckets 0`,
        );
      }
      try {
        droidResult = await parseDroidIncremental({
          settingsFiles: droidSettingsFiles,
          cursors,
          queuePath,
          // Full-scan sync: drop cursor entries for any session whose
          // settings.json has disappeared off disk so cursors.droid stays
          // bounded by the actual on-disk session count.
          prune: true,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Droid ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Droid", err, opts);
      }
    }

    // ── Zed Agent (all providers; cumulative-delta over SQLite threads) ──
    const zedDbPath = resolveZedDbPath(process.env);
    let zedResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("zed") && zedDbPath && fssync.existsSync(zedDbPath)) {
      if (progress?.enabled) {
        progress.start(`Parsing Zed Agent ${renderBar(0)} 0 threads | buckets 0`);
      }
      try {
        zedResult = await parseZedIncremental({
          dbPath: zedDbPath,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Zed Agent ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} threads | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Zed Agent", err, opts);
      }
    }

    // ── Roo Code VS Code extension (Cline-derived; rooveterinaryinc.roo-cline) ──
    const roocodeTaskFiles = sourceAllowed("roocode") ? resolveRoocodeTaskFiles(process.env) : [];
    let roocodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (roocodeTaskFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Roo Code ${renderBar(0)} 0/${formatNumber(roocodeTaskFiles.length)} tasks | buckets 0`,
        );
      }
      try {
        roocodeResult = await parseRoocodeIncremental({
          taskFiles: roocodeTaskFiles,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Roo Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} tasks | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Roo Code", err, opts);
      }
    }

    // ── Cursor (API-based) ──
    // One-time migration: earlier CLI versions mis-parsed the Cursor CSV after
    // Cursor inserted new "Cloud Agent ID"/"Automation ID" columns, writing
    // cursor records under model="unknown". Purge those local buckets, emit
    // zero retractions so the cloud upserts overwrite them to zero, and reset
    // the incremental cursor so the fixed parser re-fetches all affected rows.
    if (isFullSourceScan) {
      await migrateCursorUnknownBuckets({ cursors, queuePath });
    }

    let cursorResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("cursor") && isCursorInstalled({ home })) {
      const cursorAuth = extractCursorSessionToken({ home });
      if (cursorAuth) {
        try {
          if (progress?.enabled) {
            progress.start(`Fetching Cursor usage...`);
          }
          const csvText = await fetchCursorUsageCsv({ cookie: cursorAuth.cookie });
          const records = parseCursorCsv(csvText);
          if (records.length > 0) {
            if (progress?.enabled) {
              progress.start(
                `Parsing Cursor ${renderBar(0)} 0/${formatNumber(records.length)} records | buckets 0`,
              );
            }
            cursorResult = await parseCursorApiIncremental({
              records,
              cursors,
              queuePath,
              onProgress: (p) => {
                if (!progress?.enabled) return;
                const pct = p.total > 0 ? p.index / p.total : 1;
                progress.update(
                  `Parsing Cursor ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                    p.total,
                  )} records | buckets ${formatNumber(p.bucketsQueued)}`,
                );
              },
              source: "cursor",
            });
          }
        } catch (err) {
          if (!opts.auto) {
            process.stderr.write(`Cursor sync: ${err.message}\n`);
          }
        }
      }
    }

    // ── Kiro (SQLite-based, with JSONL fallback) ──
    let kiroResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kiroDbPath = resolveKiroDbPath();
    const kiroJsonlPath = resolveKiroJsonlPath();
    if (sourceAllowed("kiro") && (fssync.existsSync(kiroDbPath) || fssync.existsSync(kiroJsonlPath))) {
      if (progress?.enabled) {
        progress.start(`Parsing Kiro ${renderBar(0)} | buckets 0`);
      }
      try {
        kiroResult = await parseKiroIncremental({
          dbPath: kiroDbPath,
          jsonlPath: kiroJsonlPath,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kiro ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} records | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kiro", err, opts);
      }
    }

    // ── Hermes Agent (SQLite-based) ──
    let hermesResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const hermesPath = resolveHermesPath();
    if (sourceAllowed("hermes") && hermesPath && fssync.existsSync(hermesPath)) {
      if (progress?.enabled) {
        progress.start(`Parsing Hermes ${renderBar(0)} | buckets 0`);
      }
      try {
        hermesResult = await parseHermesIncremental({
          hermesPath,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Hermes ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Hermes", err, opts);
      }
    }

    // ── Kiro CLI (reads ~/Library/Application Support/kiro-cli/data.sqlite3
    //    AND live sessions under ~/.kiro/sessions/cli/{uuid}.json) ──
    // Runs IN PARALLEL with the Kiro IDE branch above — NOT instead of it.
    // Both emit source='kiro' so totals merge transparently; cursor state
    // is isolated in cursors.kiroCli. Kiro CLI does not persist explicit
    // token counts (billing is credit-based on Bedrock); we approximate at
    // 4 chars/token from user prompt chars and assistant response chars.
    let kiroCliResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kiroCliDb = resolveKiroCliDbPath(process.env);
    const kiroCliSessionFiles = sourceAllowed("kiro") ? resolveKiroCliSessionFiles(process.env) : [];
    if (sourceAllowed("kiro") && (fssync.existsSync(kiroCliDb) || kiroCliSessionFiles.length > 0)) {
      if (progress?.enabled) {
        progress.start(`Parsing Kiro CLI ${renderBar(0)} | buckets 0`);
      }
      try {
        kiroCliResult = await parseKiroCliIncremental({
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kiro CLI ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        if (!opts.auto) {
          process.stderr.write(`Kiro CLI sync: ${err.message}\n`);
        }
      }
    }

    // ── Kimi (passive wire.jsonl reader) ──
    let kimiResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kimiWireFiles = sourceAllowed("kimi") ? resolveKimiWireFiles(process.env) : [];
    if (kimiWireFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Kimi Code ${renderBar(0)} | buckets 0`);
      }
      try {
        kimiResult = await parseKimiIncremental({
          wireFiles: kimiWireFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kimi Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kimi Code", err, opts);
      }
    }

    // ── Kimi Code official (@moonshot-ai/kimi-code, ~/.kimi-code) ──
    let kimiCodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kimiCodeWireFiles = sourceAllowed("kimi-code") ? resolveKimiCodeWireFiles(process.env) : [];
    if (kimiCodeWireFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Kimi Code (official) ${renderBar(0)} | buckets 0`);
      }
      try {
        kimiCodeResult = await parseKimiCodeIncremental({
          wireFiles: kimiCodeWireFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kimi Code (official) ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kimi Code (official)", err, opts);
      }
    }

    // ── CodeBuddy CLI (passive ~/.codebuddy/projects/**/*.jsonl reader) ──
    // Tencent's CodeBuddy CLI is a Claude Code clone; no hook system, so we
    // tail the per-session JSONL conversation logs incrementally on each sync.
    let codebuddyResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const codebuddyFiles = sourceAllowed("codebuddy") ? resolveCodebuddyProjectFiles(process.env) : [];
    if (codebuddyFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing CodeBuddy ${renderBar(0)} | buckets 0`);
      }
      try {
        codebuddyResult = await parseCodebuddyIncremental({
          projectFiles: codebuddyFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing CodeBuddy ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("CodeBuddy", err, opts);
      }
    }

    // ── WorkBuddy (passive ~/.workbuddy/projects/**/*.jsonl reader) ──
    // Tencent's WorkBuddy is a Claude Code fork in the same family as CodeBuddy;
    // usage rides on function_call records too (not only assistant messages) and
    // sub-agent logs nest one level deeper, so the resolver recurses. See the
    // parser comment in rollout.js for the cache-aware token math.
    let workbuddyResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const workbuddyFiles = sourceAllowed("workbuddy") ? resolveWorkbuddyProjectFiles(process.env) : [];
    if (workbuddyFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing WorkBuddy ${renderBar(0)} | buckets 0`);
      }
      try {
        workbuddyResult = await parseWorkbuddyIncremental({
          projectFiles: workbuddyFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing WorkBuddy ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("WorkBuddy", err, opts);
      }
    }

    // ── oh-my-pi (passive ~/.omp/agent/sessions/**/*.jsonl reader) ──
    let ompResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const ompFiles = sourceAllowed("omp") ? resolveOmpSessionFiles(process.env) : [];
    if (ompFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing oh-my-pi ${renderBar(0)} | buckets 0`);
      }
      try {
        ompResult = await parseOmpIncremental({
          sessionFiles: ompFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing oh-my-pi ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("oh-my-pi", err, opts);
      }
    }

    // ── pi (@mariozechner/pi-coding-agent) — passive ~/.pi/agent/sessions/**/*.jsonl reader ──
    // Skip pi parse if its agent dir resolves to the same path as omp's. This
    // prevents double-counting when explicit overrides (TOKENTRACKER_OMP_AGENT_DIR /
    // TOKENTRACKER_PI_AGENT_DIR) bypass the install-signal disambiguator.
    let piResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const piFiles = !sourceAllowed("pi") || piAgentDirCollidesWithOmp(process.env)
      ? []
      : resolvePiSessionFiles(process.env);
    if (piFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing pi ${renderBar(0)} | buckets 0`);
      }
      try {
        piResult = await parsePiIncremental({
          sessionFiles: piFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing pi ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("pi", err, opts);
      }
    }

    // ── Craft Agents (passive ~/.craft-agent + workspaces session.jsonl reader) ──
    let craftResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const craftFiles = sourceAllowed("craft") ? resolveCraftSessionFiles(process.env) : [];
    if (craftFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Craft ${renderBar(0)} | buckets 0`);
      }
      try {
        craftResult = await parseCraftIncremental({
          sessionFiles: craftFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Craft ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Craft", err, opts);
      }
    }

    // ── Grok Build (xAI) ──
    let grokResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    // Full passive scan of all Grok sessions (historical + any not covered by hook)
    const grokSessions = sourceAllowed("grok") ? resolveGrokBuildSessions(process.env) : [];
    const grokSessionInputs = [...grokSessions];
    if (sourceAllowed("grok") && grokHookSignal && typeof grokHookSignal === "object") {
      const hookSessionId =
        typeof grokHookSignal.sessionId === "string" && grokHookSignal.sessionId.trim()
          ? grokHookSignal.sessionId.trim()
          : null;
      if (hookSessionId) {
        const hookContextTokens =
          grokHookSignal.contextTokensUsed != null
            ? grokHookSignal.contextTokensUsed
            : grokHookSignal.totalTokens;
        const hookTotalTokens =
          grokHookSignal.totalTokens != null
            ? grokHookSignal.totalTokens
            : hookContextTokens;
        grokSessionInputs.unshift({
          sessionId: hookSessionId,
          sessionDir:
            typeof grokHookSignal.sessionDir === "string" ? grokHookSignal.sessionDir : undefined,
          updatesPath:
            typeof grokHookSignal.updatesPath === "string" ? grokHookSignal.updatesPath : undefined,
          signalsPath:
            typeof grokHookSignal.signalsPath === "string" ? grokHookSignal.signalsPath : undefined,
          summaryPath:
            typeof grokHookSignal.summaryPath === "string" ? grokHookSignal.summaryPath : undefined,
          signals: {
            contextTokensUsed: hookContextTokens,
            totalTokens: hookTotalTokens,
            totalTokensBeforeCompaction: grokHookSignal.totalTokensBeforeCompaction,
            assistantMessageCount: grokHookSignal.messageCount,
            primaryModelId: grokHookSignal.model,
            lastActiveAt: grokHookSignal.lastActive,
          },
          summary: { updated_at: grokHookSignal.lastActive },
        });
        grokHookSignalConsumed = true;
      }
    }
    if (grokSessionInputs.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Grok Build ${renderBar(0)} | buckets 0`);
      }
      let grokScanResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
      try {
        grokScanResult = await parseGrokBuildIncremental({
          sessions: grokSessionInputs,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Grok Build ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Grok Build", err, opts);
      }
      grokResult = {
        recordsProcessed: grokResult.recordsProcessed + grokScanResult.recordsProcessed,
        eventsAggregated: grokResult.eventsAggregated + grokScanResult.eventsAggregated,
        bucketsQueued: grokResult.bucketsQueued + grokScanResult.bucketsQueued,
      };
    }
    if (isFullSourceScan && opts.repairGrok) {
      await repairGrokQueueFromSessionSnapshots({ cursors, queuePath, queueStatePath });
    }

    // ── GitHub Copilot CLI (OTEL JSONL files) ──
    let copilotResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const copilotPaths = sourceAllowed("copilot") ? resolveCopilotOtelPaths(process.env) : [];
    if (copilotPaths.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Copilot ${renderBar(0)} | buckets 0`);
      }
      try {
        copilotResult = await parseCopilotIncremental({
          otelPaths: copilotPaths,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Copilot ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Copilot", err, opts);
      }
    }

    if (isFullSourceScan && cursors?.projectHourly?.projects && projectQueuePath && projectQueueStatePath) {
      for (const [projectKey, meta] of Object.entries(cursors.projectHourly.projects)) {
        if (!meta || typeof meta !== "object") continue;
        if (meta.status !== "blocked" || !meta.purge_pending) continue;
        await purgeProjectUsage({
          projectKey,
          projectQueuePath,
          projectQueueStatePath,
          projectState: cursors.projectHourly,
          cursors,
        });
        meta.purge_pending = false;
        meta.purged_at = new Date().toISOString();
      }
    }

    if (isFullSourceScan) {
      await applyCloudConversationsBackfill({ cursors, queueStatePath });
    }

    cursors.updatedAt = new Date().toISOString();
    await writeJson(cursorsPath, cursors);
    if (grokHookSignalConsumed && grokHookSignalPath) {
      await fs.unlink(grokHookSignalPath).catch(() => {});
    }

    progress?.stop();

    const runtime = resolveRuntimeConfig({ config: config || {}, env: process.env });

    let uploadResult = { inserted: 0, skipped: 0 };
    let uploadAttempted = false;

    if (runtime.deviceToken && runtime.baseUrl) {
      uploadAttempted = true;
      // Mirror the machine identity into the purge-surviving seed file so a
      // future `uninstall --purge` + reinstall recovers the same cloud device
      // instead of double-counting history under a new one (issue #176). This
      // is the migration path for installs that predate the seed file.
      try {
        require("../lib/machine-id").getOrCreateMachineId(queuePath);
      } catch {
        // best effort — upload below must not be blocked by identity mirroring
      }
      try {
        uploadResult = await drainQueueToCloud({
          baseUrl: runtime.baseUrl,
          deviceToken: runtime.deviceToken,
          queuePath,
          queueStatePath,
          maxBatches: opts.drain ? 100 : 5,
          batchSize: 200,
        });
        // Record success so the exponential backoff step resets — otherwise
        // a single past failure keeps us pessimistically throttled forever.
        uploadThrottleState = recordUploadSuccess({
          nowMs: Date.now(),
          state: uploadThrottleState,
        });
        await writeJson(uploadThrottlePath, uploadThrottleState);
      } catch (e) {
        // Persist a backoff on 429 / 5xx so the next auto-sync waits instead
        // of retrying immediately and making the rate-limit worse. The
        // throttle module already parses Retry-After when we surface it on
        // the error object (drainQueueToCloud stamps err.status + err.retryAfterMs).
        uploadThrottleState = recordUploadFailure({
          nowMs: Date.now(),
          state: uploadThrottleState,
          error: e,
        });
        await writeJson(uploadThrottlePath, uploadThrottleState);
        if (!opts.auto) {
          process.stderr.write(`Upload error: ${e?.message || e}\n`);
        }
      }
    }

    const afterState = (await readJson(queueStatePath)) || { offset: 0 };
    const queueSize = await safeStatSize(queuePath);
    // Only the main queue is uploaded by drainQueueToCloud. project.queue.jsonl
    // is local project-usage state, so counting it here creates false backlog
    // and can keep auto retry alive even after cloud sync has drained.
    const pendingBytes = Math.max(0, queueSize - Number(afterState.offset || 0));

    if (pendingBytes <= 0) {
      await clearAutoRetry(trackerDir);
    } else if (opts.auto && uploadAttempted) {
      const retryAtMs = Number(uploadThrottleState?.nextAllowedAtMs || 0);
      if (retryAtMs > Date.now()) {
        await scheduleAutoRetry({
          trackerDir,
          retryAtMs,
          reason: "backlog",
          pendingBytes,
          source: autoSourceScope ? `${autoSourceScope}-backlog` : "auto-backlog",
          syncSource: autoSourceScope,
          autoRetryNoSpawn: runtime.autoRetryNoSpawn,
        });
      }
    }

    if (!opts.auto) {
      const totalParsed =
        parseResult.filesProcessed +
        openclawResult.filesProcessed +
        claudeResult.filesProcessed +
        geminiResult.filesProcessed +
        antigravityResult.filesProcessed +
        opencodeResult.filesProcessed +
        cursorResult.recordsProcessed +
        kiroResult.recordsProcessed +
        kiroCliResult.recordsProcessed +
        hermesResult.recordsProcessed +
        kimiResult.recordsProcessed +
        kimiCodeResult.recordsProcessed +
        codebuddyResult.recordsProcessed +
        workbuddyResult.recordsProcessed +
        ompResult.recordsProcessed +
        piResult.recordsProcessed +
        craftResult.recordsProcessed +
        grokResult.recordsProcessed +
        copilotResult.recordsProcessed +
        kiloResult.messagesProcessed +
        mimoResult.messagesProcessed +
        zcodeResult.messagesProcessed +
        kilocodeResult.recordsProcessed +
        roocodeResult.recordsProcessed +
        zedResult.recordsProcessed +
        gooseResult.recordsProcessed +
        droidResult.recordsProcessed;
      const totalBuckets =
        parseResult.bucketsQueued +
        openclawResult.bucketsQueued +
        claudeResult.bucketsQueued +
        geminiResult.bucketsQueued +
        antigravityResult.bucketsQueued +
        opencodeResult.bucketsQueued +
        cursorResult.bucketsQueued +
        kiroResult.bucketsQueued +
        kiroCliResult.bucketsQueued +
        hermesResult.bucketsQueued +
        kimiResult.bucketsQueued +
        kimiCodeResult.bucketsQueued +
        codebuddyResult.bucketsQueued +
        workbuddyResult.bucketsQueued +
        ompResult.bucketsQueued +
        piResult.bucketsQueued +
        craftResult.bucketsQueued +
        grokResult.bucketsQueued +
        copilotResult.bucketsQueued +
        kiloResult.bucketsQueued +
        mimoResult.bucketsQueued +
        zcodeResult.bucketsQueued +
        kilocodeResult.bucketsQueued +
        roocodeResult.bucketsQueued +
        zedResult.bucketsQueued +
        gooseResult.bucketsQueued +
        droidResult.bucketsQueued;
      process.stdout.write(
        [
          "Sync finished:",
          `- Parsed files: ${totalParsed}`,
          `- New 30-min buckets queued: ${totalBuckets}`,
          runtime.deviceToken
            ? `- Uploaded: ${uploadResult.inserted} inserted, ${uploadResult.skipped} skipped`
            : "- Uploaded: skipped (no device token)",
          runtime.deviceToken && pendingBytes > 0 && !opts.drain
            ? `- Remaining: ${formatBytes(pendingBytes)} pending (run sync again, or use --drain)`
            : null,
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  } finally {
    progress?.stop();
    await lock.release();
    await fs.unlink(lockPath).catch(() => {});
  }
}

function parseArgs(argv) {
  const out = {
    auto: false,
    fromNotify: false,
    fromRetry: false,
    fromOpenclaw: false,
    source: null,
    drain: false,
    repairGrok: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a === "--from-notify") out.fromNotify = true;
    else if (a === "--from-retry") out.fromRetry = true;
    else if (a === "--from-openclaw") out.fromOpenclaw = true;
    else if (a === "--source") {
      out.source = normalizeSyncSource(argv[i + 1]);
      i += 1;
    }
    else if (a.startsWith("--source=")) out.source = normalizeSyncSource(a.slice("--source=".length));
    else if (a === "--drain") out.drain = true;
    else if (a === "--repair-grok") out.repairGrok = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

function resolveAutoSourceScope(opts) {
  if (!opts?.auto) return null;
  if (opts.fromOpenclaw) return "openclaw";
  if (opts.fromRetry) return normalizeSyncSource(opts.source);
  if (!opts.fromNotify) return null;
  return normalizeSyncSource(opts.source);
}

function normalizeSyncSource(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const aliased = AUTO_SYNC_SOURCE_ALIASES.get(normalized) || normalized;
  return AUTO_SYNC_SOURCES.has(aliased) ? aliased : null;
}

function isCodexColdScanAuditDue(cursors, nowMs = Date.now()) {
  const state = cursors?.codexColdScanAudit;
  if (!state || typeof state !== "object" || state.version !== 1) return true;
  const lastFullScanAtMs = Number(state.lastFullScanAtMs);
  if (!Number.isFinite(lastFullScanAtMs) || lastFullScanAtMs <= 0) return true;
  if (Number.isFinite(nowMs) && lastFullScanAtMs - nowMs > 5 * 60 * 1000) return true;
  if (Number.isFinite(nowMs) && nowMs - lastFullScanAtMs >= CODEX_COLD_SCAN_AUDIT_INTERVAL_MS) {
    return true;
  }
  const syncsSinceFullScan = Number(state.syncsSinceFullScan || 0);
  return (
    Number.isFinite(syncsSinceFullScan) &&
    syncsSinceFullScan >= CODEX_COLD_SCAN_AUDIT_MAX_SYNCS
  );
}

function recordCodexColdScanAudit(cursors, { fullAudit = false, skipped = 0 } = {}, nowMs = Date.now()) {
  if (!cursors || typeof cursors !== "object") return;
  const prev =
    cursors.codexColdScanAudit && typeof cursors.codexColdScanAudit === "object"
      ? cursors.codexColdScanAudit
      : {};
  const previousSyncs = Number(prev.syncsSinceFullScan || 0);
  const lastFullScanAtMs = Number(prev.lastFullScanAtMs);
  const next = {
    version: 1,
    lastFullScanAtMs: Number.isFinite(lastFullScanAtMs) && lastFullScanAtMs > 0
      ? lastFullScanAtMs
      : nowMs,
    syncsSinceFullScan: Number.isFinite(previousSyncs) && previousSyncs > 0
      ? previousSyncs
      : 0,
    lastSkippedFiles: Math.max(0, Number(skipped) || 0),
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (fullAudit) {
    next.lastFullScanAtMs = nowMs;
    next.lastFullScanAt = new Date(nowMs).toISOString();
    next.syncsSinceFullScan = 0;
  } else {
    next.lastFullScanAt = Number.isFinite(next.lastFullScanAtMs)
      ? new Date(next.lastFullScanAtMs).toISOString()
      : null;
    next.syncsSinceFullScan += 1;
  }
  cursors.codexColdScanAudit = next;
}

module.exports = {
  cmdSync,
  migrateCursorUnknownBuckets,
  migrateRolloutCumulativeDeltaBuckets,
  repairCodexRescanInflation,
  repairDroidDuplicateSessionInflation,
  repairMimoClaudeMislabel,
  reincludeClaudeMemObserverFiles,
  repairGrokQueueFromSessionSnapshots,
  applyCloudConversationsBackfill,
  scheduleAutoRetry,
  buildAutoRetryScript,
  isCodexColdScanAuditDue,
  recordCodexColdScanAudit,
  CURSOR_UNKNOWN_MIGRATION_KEY,
  ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY,
  CODEX_RESCAN_DEDUP_REPAIR_KEY,
  DROID_DUP_SESSION_REPAIR_KEY,
  CLAUDE_MEM_OBSERVER_REINCLUDE_KEY,
  GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY,
  CLOUD_CONVERSATIONS_BACKFILL_KEY,
};

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOpenclawSignal({ home, env } = {}) {
  if (!env) return null;

  const agentId = normalizeString(env.TOKENTRACKER_OPENCLAW_AGENT_ID);
  const sessionId = normalizeString(env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID);
  if (!agentId || !sessionId) return null;

  const openclawHome =
    normalizeString(env.TOKENTRACKER_OPENCLAW_HOME) || path.join(home || os.homedir(), ".openclaw");
  const sessionFile = path.join(openclawHome, "agents", agentId, "sessions", `${sessionId}.jsonl`);

  const prevTotals = {
    totalTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS),
    inputTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS),
    outputTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS),
    model: normalizeString(env.TOKENTRACKER_OPENCLAW_PREV_MODEL),
    updatedAt: normalizeIsoOrEpoch(env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT),
  };

  return {
    agentId,
    sessionId,
    sessionKey: normalizeString(env.TOKENTRACKER_OPENCLAW_SESSION_KEY),
    openclawHome,
    sessionFile,
    prevTotals,
  };
}

async function applyOpenclawTotalsFallback({
  trackerDir,
  signal,
  cursors,
  queuePath,
  projectQueuePath,
}) {
  const totalTokens = Number(signal?.prevTotals?.totalTokens || 0);
  if (!trackerDir || !signal || totalTokens <= 0) {
    return { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const sessionKey = `${signal.agentId}:${signal.sessionId}`;
  const statePath = path.join(trackerDir, "openclaw.fallback.state.json");
  const fallbackFilePath = path.join(trackerDir, "openclaw.fallback.jsonl");
  const state = (await readJson(statePath)) || { version: 1, sessions: {} };
  const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
  const prev =
    sessions[sessionKey] && typeof sessions[sessionKey] === "object" ? sessions[sessionKey] : null;

  const current = {
    totalTokens: normalizeNonNegativeInt(signal?.prevTotals?.totalTokens) || 0,
    inputTokens: normalizeNonNegativeInt(signal?.prevTotals?.inputTokens) || 0,
    outputTokens: normalizeNonNegativeInt(signal?.prevTotals?.outputTokens) || 0,
    model: normalizeString(signal?.prevTotals?.model) || "unknown",
    updatedAt: normalizeIsoOrEpoch(signal?.prevTotals?.updatedAt) || new Date().toISOString(),
    seenAt: new Date().toISOString(),
  };

  let deltaTotal = current.totalTokens;
  let deltaInput = current.inputTokens;
  let deltaOutput = current.outputTokens;
  if (prev) {
    deltaTotal = Math.max(
      0,
      current.totalTokens - (normalizeNonNegativeInt(prev.totalTokens) || 0),
    );
    deltaInput = Math.max(
      0,
      current.inputTokens - (normalizeNonNegativeInt(prev.inputTokens) || 0),
    );
    deltaOutput = Math.max(
      0,
      current.outputTokens - (normalizeNonNegativeInt(prev.outputTokens) || 0),
    );
  }

  if (deltaTotal > 0 && deltaInput + deltaOutput === 0) {
    deltaInput = deltaTotal;
  }

  sessions[sessionKey] = current;
  state.version = 1;
  state.sessions = sessions;

  if (deltaTotal <= 0) {
    await writeJson(statePath, state);
    return { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  await ensureDir(path.dirname(fallbackFilePath));
  const syntheticMessage = {
    type: "message",
    timestamp: current.updatedAt,
    message: {
      role: "assistant",
      model: current.model,
      usage: {
        input: deltaInput,
        output: deltaOutput,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: deltaTotal,
      },
    },
  };
  await fs.appendFile(fallbackFilePath, `${JSON.stringify(syntheticMessage)}\n`, "utf8");
  await writeJson(statePath, state);

  return parseOpenclawIncremental({
    sessionFiles: [{ path: fallbackFilePath, source: "openclaw" }],
    cursors,
    queuePath,
    projectQueuePath,
    source: "openclaw",
  });
}

function normalizeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function normalizeIsoOrEpoch(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !Number.isNaN(Date.parse(trimmed))) return trimmed;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric);
      const iso = new Date(ms).toISOString();
      if (!Number.isNaN(Date.parse(iso))) return iso;
    }
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

async function safeStatSize(p) {
  try {
    const st = await fs.stat(p);
    return st && st.isFile() ? st.size : 0;
  } catch (_e) {
    return 0;
  }
}

function deriveAutoSkipReason({ decision, state }) {
  if (!decision || decision.reason !== "throttled") return decision?.reason || "unknown";
  const backoffUntilMs = Number(state?.backoffUntilMs || 0);
  const nextAllowedAtMs = Number(state?.nextAllowedAtMs || 0);
  if (backoffUntilMs > 0 && backoffUntilMs >= nextAllowedAtMs) return "backoff";
  return "throttled";
}

async function scheduleAutoRetry({
  trackerDir,
  retryAtMs,
  reason,
  pendingBytes,
  source,
  syncSource,
  autoRetryNoSpawn,
}) {
  const retryMs = coerceRetryMs(retryAtMs);
  if (!retryMs) return { scheduled: false, retryAtMs: 0 };

  const retryPath = path.join(trackerDir, AUTO_RETRY_FILENAME);
  const nowMs = Date.now();
  const existing = await readJson(retryPath);
  const existingMs = coerceRetryMs(existing?.retryAtMs);
  const normalizedSyncSource = normalizeSyncSource(syncSource);
  if (existingMs && existingMs >= retryMs - 1000) {
    const existingSyncSource = normalizeSyncSource(existing?.syncSource);
    if (existingSyncSource !== normalizedSyncSource) {
      await writeJson(
        retryPath,
        buildAutoRetryPayload({
          retryMs: existingMs,
          nowMs,
          reason,
          pendingBytes,
          source,
          syncSource: normalizedSyncSource,
        }),
      );
    }
    return { scheduled: false, retryAtMs: existingMs };
  }

  const payload = buildAutoRetryPayload({
    retryMs,
    nowMs,
    reason,
    pendingBytes,
    source,
    syncSource: normalizedSyncSource,
  });

  await writeJson(retryPath, payload);

  const delayMs = Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.max(0, retryMs - nowMs));
  if (delayMs <= 0) return { scheduled: false, retryAtMs: retryMs };
  if (autoRetryNoSpawn) {
    return { scheduled: false, retryAtMs: retryMs };
  }

  spawnAutoRetryProcess({
    retryPath,
    trackerBinPath: path.join(trackerDir, "app", "bin", "tracker.js"),
    fallbackPkg: "tokentracker-cli",
    delayMs,
  });
  return { scheduled: true, retryAtMs: retryMs };
}

function buildAutoRetryPayload({ retryMs, nowMs, reason, pendingBytes, source, syncSource }) {
  const payload = {
    version: 1,
    retryAtMs: retryMs,
    retryAt: new Date(retryMs).toISOString(),
    reason: typeof reason === "string" && reason.length > 0 ? reason : "throttled",
    pendingBytes: Math.max(0, Number(pendingBytes || 0)),
    scheduledAt: new Date(nowMs).toISOString(),
    source: typeof source === "string" ? source : "auto",
  };
  if (syncSource) payload.syncSource = syncSource;
  return payload;
}

async function clearAutoRetry(trackerDir) {
  const retryPath = path.join(trackerDir, AUTO_RETRY_FILENAME);
  await fs.unlink(retryPath).catch(() => {});
}

function spawnAutoRetryProcess({ retryPath, trackerBinPath, fallbackPkg, delayMs }) {
  const script = buildAutoRetryScript({ retryPath, trackerBinPath, fallbackPkg, delayMs });
  try {
    const child = cp.spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (_e) {}
}

function buildAutoRetryScript({ retryPath, trackerBinPath, fallbackPkg, delayMs }) {
  return (
    `'use strict';\n` +
    `const fs = require('node:fs');\n` +
    `const cp = require('node:child_process');\n` +
    `const retryPath = ${JSON.stringify(retryPath)};\n` +
    `const trackerBinPath = ${JSON.stringify(trackerBinPath)};\n` +
    `const fallbackPkg = ${JSON.stringify(fallbackPkg)};\n` +
    `const delayMs = ${Math.max(0, Math.floor(delayMs || 0))};\n` +
    `setTimeout(() => {\n` +
    `  let payload = null;\n` +
    `  let retryAtMs = 0;\n` +
    `  try {\n` +
    `    const raw = fs.readFileSync(retryPath, 'utf8');\n` +
    `    payload = JSON.parse(raw);\n` +
    `    retryAtMs = Number(payload.retryAtMs || 0);\n` +
    `  } catch (_) {}\n` +
    `  if (!retryAtMs || Date.now() + 1000 < retryAtMs) process.exit(0);\n` +
    `  const argv = ['sync', '--auto', '--from-retry'];\n` +
    `  if (payload && typeof payload.syncSource === 'string' && payload.syncSource.trim()) {\n` +
    `    argv.push('--source', payload.syncSource.trim());\n` +
    `  }\n` +
    `  const cmd = fs.existsSync(trackerBinPath)\n` +
    `    ? [process.execPath, trackerBinPath, ...argv]\n` +
    `    : ['npx', '--yes', fallbackPkg, ...argv];\n` +
    `  try {\n` +
    `    const child = cp.spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', env: process.env });\n` +
    `    child.unref();\n` +
    `  } catch (_) {}\n` +
    `}, delayMs);\n`
  );
}

function coerceRetryMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

async function writeOpenclawSignal(trackerDir) {
  const openclawSignalPath = path.join(trackerDir, "openclaw.signal");
  try {
    await fs.writeFile(openclawSignalPath, new Date().toISOString(), "utf8");
  } catch (_e) {
    // best-effort marker
  }
}

const AUTO_RETRY_FILENAME = "auto.retry.json";
const AUTO_RETRY_MAX_DELAY_MS = 2 * 60 * 60 * 1000;

const INGEST_SLUG = "tokentracker-ingest";
const MAX_INGEST_BUCKETS = 500;

async function drainQueueToCloud({ baseUrl, deviceToken, queuePath, queueStatePath, maxBatches = 5, batchSize = 200 }) {
  const state = (await readJson(queueStatePath)) || { offset: 0 };
  let offset = Number(state.offset || 0);
  let inserted = 0;
  let skipped = 0;

  const queueSize = await safeStatSize(queuePath);
  const limit = Math.min(Math.max(1, Math.floor(Number(batchSize || 200))), MAX_INGEST_BUCKETS);

  for (let batch = 0; batch < maxBatches; batch++) {
    if (offset >= queueSize) break;
    const result = await readQueueBatch(queuePath, offset, limit);
    if (result.buckets.length === 0) break;

    const root = baseUrl.replace(/\/$/, "");
    const anonKey = process.env.TOKENTRACKER_INSFORGE_ANON_KEY || "";
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${deviceToken}`,
    };
    if (anonKey) headers.apikey = anonKey;
    const res = await fetch(`${root}/functions/${INGEST_SLUG}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hourly: result.buckets }),
    });

    const rawText = await res.text().catch(() => "");
    let data = {};
    try { data = JSON.parse(rawText); } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${rawText.substring(0, 500)}`);
      err.status = res.status;
      const retryAfter = res.headers?.get?.("Retry-After") ?? null;
      const retryAfterMs = parseRetryAfterMs(retryAfter);
      if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
      throw err;
    }

    inserted += Number(data?.inserted || 0);
    skipped += Number(data?.skipped || 0);

    offset = result.nextOffset;
    state.offset = offset;
    state.updatedAt = new Date().toISOString();
    await writeJson(queueStatePath, state);
  }

  return { inserted, skipped };
}

async function readQueueBatch(queuePath, startOffset, maxBuckets) {
  const st = await fs.stat(queuePath).catch(() => null);
  if (!st || !st.isFile()) return { buckets: [], nextOffset: startOffset };
  if (startOffset >= st.size) return { buckets: [], nextOffset: startOffset };

  const stream = fssync.createReadStream(queuePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const bucketMap = new Map();
  let offset = startOffset;
  let linesRead = 0;
  for await (const line of rl) {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    offset += bytes;
    if (!line.trim()) continue;
    let bucket;
    try {
      bucket = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const hourStart = typeof bucket?.hour_start === "string" ? bucket.hour_start : null;
    if (!hourStart) continue;
    const source = (typeof bucket?.source === "string" ? bucket.source.trim().toLowerCase() : "") || "codex";
    const model = (typeof bucket?.model === "string" ? bucket.model.trim() : "") || "unknown";
    bucket.source = source;
    bucket.model = model;
    // Apply the same legacy-row corrections every local reader applies
    // (local-api readQueueData / project queue / wrapped aggregator). Without
    // this the cloud permanently kept the RAW legacy values — e.g. old Codex
    // rows whose input_tokens still include cached tokens (6-7x inflated) —
    // while the local dashboard showed corrected numbers.
    bucket = require("../lib/local-api").normalizeQueueRow(bucket);
    bucketMap.set(`${source}|${model}|${hourStart}`, bucket);
    linesRead += 1;
    if (linesRead >= maxBuckets) break;
  }

  rl.close();
  stream.close?.();
  return { buckets: Array.from(bucketMap.values()), nextOffset: offset };
}

function normalizeGrokRepairSource(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeGrokRepairModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "grok-build";
}

function normalizeGrokRepairNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toGrokRepairHalfHourStart(value) {
  if (value == null) return null;
  const millis =
    typeof value === "number"
      ? value < 10_000_000_000
        ? value * 1000
        : value
      : Date.parse(String(value));
  if (!Number.isFinite(millis)) return null;
  const halfHourMs = 30 * 60 * 1000;
  return new Date(Math.floor(millis / halfHourMs) * halfHourMs).toISOString();
}

function estimateGrokRepairTotals(totalTokens, conversationCount) {
  const total = Math.trunc(normalizeGrokRepairNumber(totalTokens));
  const inputTokens = Math.round(total * 0.8);
  const outputTokens = Math.max(0, total - inputTokens);
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
    conversation_count: Math.trunc(normalizeGrokRepairNumber(conversationCount)),
  };
}

function addGrokRepairTotals(target, delta) {
  target.input_tokens += delta.input_tokens;
  target.cached_input_tokens += delta.cached_input_tokens;
  target.cache_creation_input_tokens += delta.cache_creation_input_tokens;
  target.output_tokens += delta.output_tokens;
  target.reasoning_output_tokens += delta.reasoning_output_tokens;
  target.total_tokens += delta.total_tokens;
  target.billable_total_tokens += delta.billable_total_tokens;
  target.conversation_count += delta.conversation_count;
}

function buildGrokRepairRowsFromSnapshots(sessionSnapshots) {
  if (!sessionSnapshots || typeof sessionSnapshots !== "object") return [];

  const buckets = new Map();
  for (const snapshot of Object.values(sessionSnapshots)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const totalTokens = Math.trunc(normalizeGrokRepairNumber(snapshot.totalTokens));
    if (totalTokens <= 0) continue;

    const hourStart = toGrokRepairHalfHourStart(
      snapshot.lastEventTimestamp || snapshot.updatedAt,
    );
    if (!hourStart) continue;

    const model = normalizeGrokRepairModel(snapshot.model);
    const key = bucketKey("grok", model, hourStart);
    let totals = buckets.get(key);
    if (!totals) {
      totals = {
        source: "grok",
        model,
        hour_start: hourStart,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        billable_total_tokens: 0,
        conversation_count: 0,
      };
      buckets.set(key, totals);
    }
    addGrokRepairTotals(
      totals,
      estimateGrokRepairTotals(totalTokens, snapshot.messageCount),
    );
  }

  return Array.from(buckets.values()).sort((a, b) => {
    const timeCompare = a.hour_start.localeCompare(b.hour_start);
    return timeCompare || a.model.localeCompare(b.model);
  });
}

function applyGrokRepairHourlyState(cursors, rows) {
  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : {};
  const buckets = hourly.buckets && typeof hourly.buckets === "object" ? hourly.buckets : {};
  const groupQueued =
    hourly.groupQueued && typeof hourly.groupQueued === "object" ? hourly.groupQueued : {};

  for (const key of Object.keys(buckets)) {
    if (key.startsWith("grok|")) {
      delete buckets[key];
    }
  }
  for (const key of Object.keys(groupQueued)) {
    if (key.startsWith("grok|")) {
      delete groupQueued[key];
    }
  }

  for (const row of rows) {
    const totals = {
      input_tokens: row.input_tokens,
      cached_input_tokens: row.cached_input_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      output_tokens: row.output_tokens,
      reasoning_output_tokens: row.reasoning_output_tokens,
      total_tokens: row.total_tokens,
      billable_total_tokens: row.billable_total_tokens,
      conversation_count: row.conversation_count,
    };
    buckets[bucketKey("grok", row.model, row.hour_start)] = {
      totals,
      queuedKey: totalsKey(totals),
      source: "grok",
      hour_start: row.hour_start,
    };
  }

  cursors.hourly = {
    ...hourly,
    version: 3,
    buckets,
    groupQueued,
    updatedAt: typeof hourly.updatedAt === "string" ? hourly.updatedAt : null,
  };
}

async function resetGrokRepairUploadOffset(queueStatePath) {
  if (typeof queueStatePath !== "string" || !queueStatePath) return false;
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  } catch (_e) {
    state = {};
  }
  state.offset = 0;
  state.updatedAt = new Date().toISOString();
  state.note = "reset_after_grok_append_only_repair_2026_05_v4";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return true;
}

function hasAppliedGrokRepairMigration(value) {
  if (!value) return false;
  if (value === true) return true;
  if (value && typeof value === "object") {
    if (value.status === "applied" || value.status === "noop") return true;
    if (value.status) return false;
    return value.rowsWritten != null || value.rowsRemoved != null;
  }
  return false;
}

function serializeGrokRepairRow(row) {
  return JSON.stringify({
    source: "grok",
    model: normalizeGrokRepairModel(row.model),
    hour_start: row.hour_start,
    input_tokens: row.input_tokens || 0,
    cached_input_tokens: row.cached_input_tokens || 0,
    cache_creation_input_tokens: row.cache_creation_input_tokens || 0,
    output_tokens: row.output_tokens || 0,
    reasoning_output_tokens: row.reasoning_output_tokens || 0,
    total_tokens: row.total_tokens || 0,
    billable_total_tokens: row.billable_total_tokens || 0,
    conversation_count: row.conversation_count || 0,
  });
}

async function backupExistingFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak.${stamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function resetUploadOffsetForMimoRepair(queueStatePath) {
  if (typeof queueStatePath !== "string" || !queueStatePath) return false;
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  } catch (_e) {
    state = {};
  }
  state.offset = 0;
  state.updatedAt = new Date().toISOString();
  state.note = "reset_after_mimo_claude_mislabel_repair_2026_06";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return true;
}

// Remove every source=mimo row from a queue file (atomic rewrite, backed up
// first). Returns the number of rows removed. Non-JSON lines are preserved.
async function dropMimoQueueRows(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  const kept = [];
  let removed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      kept.push(line);
      continue;
    }
    if (row && row.source === "mimo") {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return 0;
  await backupExistingFile(filePath);
  const tmp = `${filePath}.mimorepair.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  await fs.rename(tmp, filePath);
  return removed;
}

// One-time repair for the 0.57.0 mimo mislabel bug. Purges all source=mimo data
// (the mislabeled Claude/claude-mem mirror) from the local queues and cursor
// state, so the next sync re-parses mimocode.db with the providerID-filtered
// reader and rebuilds source=mimo from scratch — correct mimo-auto only. Cloud
// orphans (mimo rows already uploaded) are cleaned server-side separately.
async function repairMimoClaudeMislabel({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
} = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[MIMO_PROVIDER_REPAIR_KEY]) return false;

  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : null;
  const hasMimoBucket =
    hourly && hourly.buckets
      ? Object.keys(hourly.buckets).some((k) => k.startsWith("mimo|"))
      : false;

  // Nothing mimo-related anywhere → mark done so we don't re-scan every sync.
  let mainRaw = null;
  try {
    mainRaw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const hasMimoRow =
    typeof mainRaw === "string" &&
    mainRaw.split("\n").some((l) => {
      if (!l.trim()) return false;
      try {
        return JSON.parse(l).source === "mimo";
      } catch (_e) {
        return false;
      }
    });

  if (!hasMimoBucket && !hasMimoRow && !cursors.mimo) {
    migrations[MIMO_PROVIDER_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // 1. Drop source=mimo rows from the main + project queues.
  const removedMain = await dropMimoQueueRows(queuePath);
  const removedProject =
    typeof projectQueuePath === "string" && projectQueuePath
      ? await dropMimoQueueRows(projectQueuePath)
      : 0;

  // 2. Clear stale mimo buckets from the aggregation state (keys are
  //    `source|model|hour` for hourly, `projectKey|source|hour` for project).
  if (hourly && hourly.buckets) {
    for (const k of Object.keys(hourly.buckets)) {
      if (k.startsWith("mimo|")) delete hourly.buckets[k];
    }
  }
  if (hourly && hourly.groupQueued) {
    for (const k of Object.keys(hourly.groupQueued)) {
      if (k.startsWith("mimo|")) delete hourly.groupQueued[k];
    }
  }
  const projectHourly =
    cursors.projectHourly && typeof cursors.projectHourly === "object"
      ? cursors.projectHourly
      : null;
  if (projectHourly && projectHourly.buckets) {
    for (const k of Object.keys(projectHourly.buckets)) {
      if (k.includes("|mimo|")) delete projectHourly.buckets[k];
    }
  }

  // 3. Reset the mimo message index so the next sync re-parses the DB fresh.
  delete cursors.mimo;

  // 4. Reset upload offsets — the queue rewrite changed byte offsets, so a full
  //    replay is required (cloud keeps latest per key; orphan mimo rows already
  //    uploaded are removed server-side).
  if (removedMain > 0) await resetUploadOffsetForMimoRepair(queueStatePath);
  if (removedProject > 0) await resetUploadOffsetForMimoRepair(projectQueueStatePath);

  migrations[MIMO_PROVIDER_REPAIR_KEY] = {
    appliedAt: new Date().toISOString(),
    removedMain,
    removedProject,
  };
  return true;
}

async function repairGrokQueueFromSessionSnapshots({ cursors, queuePath, queueStatePath } = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const grokState = (cursors.grok ||= {});
  const migrations = (grokState.migrations ||= {});
  if (hasAppliedGrokRepairMigration(migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY])) {
    return false;
  }

  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }

  const latestGrokRows = new Map();
  let existingGrokRows = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    if (normalizeGrokRepairSource(row?.source) === "grok") {
      const model = normalizeGrokRepairModel(row.model);
      const hourStart = typeof row.hour_start === "string" ? row.hour_start : null;
      if (!hourStart) continue;
      existingGrokRows += 1;
      latestGrokRows.set(bucketKey("grok", model, hourStart), {
        ...row,
        source: "grok",
        model,
        hour_start: hourStart,
      });
    }
  }

  if (existingGrokRows === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      existingGrokRows: 0,
      rowsWritten: 0,
      snapshotsUsed: 0,
      uploadOffsetReset: false,
    };
    return false;
  }

  const repairRows = buildGrokRepairRowsFromSnapshots(grokState.sessionSnapshots);
  if (repairRows.length === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "skipped",
      appliedAt: new Date().toISOString(),
      reason: "missing-session-snapshots",
      existingGrokRows,
      rowsWritten: 0,
      snapshotsUsed: 0,
      uploadOffsetReset: false,
    };
    return false;
  }

  applyGrokRepairHourlyState(cursors, repairRows);

  const repairLines = [];
  const repairKeys = new Set();
  for (const row of repairRows) {
    const key = bucketKey("grok", row.model, row.hour_start);
    repairKeys.add(key);
    const current = latestGrokRows.get(key);
    if (current && totalsKey(current) === totalsKey(row)) continue;
    repairLines.push(serializeGrokRepairRow(row));
  }

  const zeroTotals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    billable_total_tokens: 0,
    conversation_count: 0,
  };
  let staleRowsRetracted = 0;
  for (const [key, row] of latestGrokRows.entries()) {
    if (repairKeys.has(key)) continue;
    if (totalsKey(row) === totalsKey(zeroTotals)) continue;
    staleRowsRetracted += 1;
    repairLines.push(serializeGrokRepairRow({
      ...zeroTotals,
      model: row.model,
      hour_start: row.hour_start,
    }));
  }

  if (repairLines.length === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      existingGrokRows,
      rowsWritten: 0,
      staleRowsRetracted,
      snapshotsUsed: repairRows.length,
      uploadOffsetReset: false,
    };
    return false;
  }

  await ensureDir(path.dirname(queuePath));
  const queueBackupPath = await backupExistingFile(queuePath);
  const queueStateBackupPath = await backupExistingFile(queueStatePath);
  await fs.appendFile(queuePath, `${repairLines.join("\n")}\n`, "utf8");

  const uploadOffsetReset = await resetGrokRepairUploadOffset(queueStatePath);
  migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
    status: "applied",
    appliedAt: new Date().toISOString(),
    existingGrokRows,
    rowsWritten: repairLines.length,
    staleRowsRetracted,
    snapshotsUsed: Object.values(grokState.sessionSnapshots || {}).filter((snapshot) => {
      if (!snapshot || typeof snapshot !== "object") return false;
      if (Math.trunc(normalizeGrokRepairNumber(snapshot.totalTokens)) <= 0) return false;
      return Boolean(toGrokRepairHalfHourStart(snapshot.lastEventTimestamp || snapshot.updatedAt));
    }).length,
    uploadOffsetReset,
    queueBackupPath,
    queueStateBackupPath,
  };
  return true;
}

async function applyCloudConversationsBackfill({ cursors, queueStatePath }) {
  if (!cursors || typeof cursors !== "object") return false;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[CLOUD_CONVERSATIONS_BACKFILL_KEY]) return false;

  // Reset ONLY the cloud upload offset. The queue file itself is untouched;
  // ingest upserts are idempotent per (user, device, hour, source, model),
  // so replaying the whole queue is safe — it costs upload batches, not
  // correctness. Project queue is never uploaded and is not touched.
  let prevOffset = 0;
  try {
    const st = (await readJson(queueStatePath)) || {};
    prevOffset = Number(st.offset || 0);
  } catch (_e) {
    /* missing state file — nothing to reset */
  }
  if (prevOffset > 0) {
    await writeJson(queueStatePath, { offset: 0, updatedAt: new Date().toISOString() });
  }
  cursors.migrations[CLOUD_CONVERSATIONS_BACKFILL_KEY] = {
    appliedAt: new Date().toISOString(),
    previousOffset: prevOffset,
  };
  return prevOffset > 0;
}

async function migrateCursorUnknownBuckets({ cursors, queuePath }) {
  if (!cursors || typeof cursors !== "object") return;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY]) return;

  const buckets = cursors.hourly?.buckets;
  if (!buckets || typeof buckets !== "object") {
    cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY] = new Date().toISOString();
    return;
  }

  const retractions = [];
  for (const key of Object.keys(buckets)) {
    if (!key.startsWith("cursor|unknown|")) continue;
    const hourStart = key.split("|").slice(2).join("|");
    retractions.push(
      JSON.stringify({
        source: "cursor",
        model: "unknown",
        hour_start: hourStart,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        conversation_count: 0,
      }),
    );
    delete buckets[key];
  }

  if (retractions.length > 0) {
    await ensureDir(path.dirname(queuePath));
    await fs.appendFile(queuePath, retractions.join("\n") + "\n");
    if (cursors.cursorApi) {
      cursors.cursorApi.lastRecordTimestamp = null;
    }
  }

  cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY] = new Date().toISOString();
}

async function migrateRolloutCumulativeDeltaBuckets({ cursors, queuePath, rolloutFiles }) {
  if (!cursors || typeof cursors !== "object") return;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY]) return;

  const rolloutPathSources = new Map();
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    const source = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (!filePath) continue;
    if (source === "codex" || source === "every-code") {
      rolloutPathSources.set(filePath, source);
    }
  }

  if (cursors.files && typeof cursors.files === "object") {
    for (const filePath of rolloutPathSources.keys()) {
      delete cursors.files[filePath];
    }
  }

  const buckets = cursors.hourly?.buckets;
  const retractions = [];
  if (buckets && typeof buckets === "object") {
    for (const key of Object.keys(buckets)) {
      const [source, model, ...hourParts] = key.split("|");
      if (source !== "codex" && source !== "every-code") continue;
      const hourStart = hourParts.join("|");
      retractions.push(
        JSON.stringify({
          source,
          model: model || "unknown",
          hour_start: hourStart,
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
          billable_total_tokens: 0,
          conversation_count: 0,
        }),
      );
      delete buckets[key];
    }
  }

  const groupQueued = cursors.hourly?.groupQueued;
  if (groupQueued && typeof groupQueued === "object") {
    for (const key of Object.keys(groupQueued)) {
      if (key.startsWith("codex|") || key.startsWith("every-code|")) {
        delete groupQueued[key];
      }
    }
  }

  if (retractions.length > 0) {
    await ensureDir(path.dirname(queuePath));
    await fs.appendFile(queuePath, retractions.join("\n") + "\n");
  }

  cursors.migrations[ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY] = new Date().toISOString();
}

// One-time repair (#187): rebuild codex hourly buckets that the inode-keyed
// re-scan double-counted before the codexHashes event-dedup landed, and push
// the corrected values to the cloud. Runs BEFORE the codex parse in the same
// sync: it clears codex hourly state + codexHashes so the parse rebuilds clean,
// atomically strips the inflated codex rows from queue.jsonl, and resets the
// upload offset so the re-uploaded clean rows overwrite the cloud (with no
// stale-high codex rows left in the queue, the ingest's within-batch MAX keeps
// nothing larger, so its overwrite-upsert replaces the inflated cloud rows).
//
// GUARDED against the v6 ground-truth-repair data-loss incident: a clear+reparse
// rebuilds codex buckets ONLY from the codex files this sync re-parses (now both
// sessions/ AND archived_sessions/), so if any codex file that previously
// contributed is gone from disk (genuinely deleted — Codex-Manager log rotation
// or user cleanup) the migration is skipped entirely — the forward dedup fix
// still prevents new double-counting; only this historical correction is deferred.
async function repairCodexRescanInflation({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
  rolloutFiles,
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  // A COMPLETED run writes an ISO-string timestamp (final — never re-run). A
  // prior SKIP writes an object {skipped:true} and MUST be retried: the skip
  // condition can clear in a later version (e.g. v0.53.4 started scanning
  // archived_sessions/, so a session that was "unscanned" under v0.53.3 is now
  // found). Treating the skip sentinel as "done" is what left users like #187
  // permanently stuck on the inflated value after upgrading (the key was truthy
  // so the guard never got a second chance).
  const priorRepair = migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY];
  if (priorRepair && !(typeof priorRepair === "object" && priorRepair.skipped)) return false;

  // Codex session files THIS sync discovered (source === "codex").
  const codexFiles = [];
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const fp = typeof entry === "string" ? entry : entry?.path;
    const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (fp && src === "codex") codexFiles.push(fp);
  }
  const codexFileSet = new Set(codexFiles);
  const projectRepairEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;

  // GUARD (data-loss prevention, ref the v6 ground-truth-repair incident): the
  // rebuild can only reproduce buckets from the files this sync re-parses
  // (codexFiles, now covering sessions/ AND archived_sessions/). If a session
  // that previously contributed can no longer be reproduced, skip entirely —
  // the forward dedup fix still stops NEW double-counting; only this historical
  // correction defers.
  //
  // Reproducibility is keyed on the session UUID, NOT the exact cursor path:
  // Codex-Manager MOVES a file sessions/ -> archived_sessions/ (path changes,
  // UUID does not). A path-based check false-positives on every moved file as
  // "missing" and skips forever (issue #187, easonlee05). Genuinely deleted
  // sessions (no file with that UUID anywhere in the scan) still defer.
  const scannedSessionIds = new Set();
  for (const fp of codexFiles) {
    const id = codexSessionIdFromPath(fp);
    if (id) scannedSessionIds.add(id);
  }
  if (cursors.files && typeof cursors.files === "object") {
    for (const fp of Object.keys(cursors.files)) {
      if (!isCodexSessionCursorPath(fp)) continue;
      if (codexFileSet.has(fp)) continue; // exact file re-scanned this run
      const id = codexSessionIdFromPath(fp);
      if (id && scannedSessionIds.has(id)) continue; // same session scanned elsewhere (moved)
      migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY] = {
        skipped: true,
        reason: "codex_session_unreproducible",
        at: new Date().toISOString(),
      };
      return false;
    }
  }

  // ATOMIC REBUILD into a THROWAWAY cursors + queue: never touch the live
  // buckets/queue until the rebuild has fully succeeded. If anything throws we
  // return WITHOUT mutating any persistent state and the migration retries next
  // sync (the key is not set). This is the crucial difference from a
  // "clear-then-rely-on-the-later-parse" design: the later parse's failure is
  // swallowed (warnProviderParseFailure) and cursors are saved regardless, which
  // would permanently zero a user's codex history.
  let rebuilt;
  const tmpQueue = `${queuePath}.codexrebuild.${process.pid}.${Date.now()}`;
  const tmpProjectQueue = projectRepairEnabled
    ? `${projectQueuePath}.codexrebuild.${process.pid}.${Date.now()}`
    : null;
  try {
    const tmpCursors = {
      version: 1,
      files: {},
      hourly: { buckets: {}, groupQueued: {} },
      codexHashes: [],
    };
    await parseRolloutIncremental({
      rolloutFiles: codexFiles.map((p) => ({ path: p, source: "codex" })),
      cursors: tmpCursors,
      queuePath: tmpQueue,
      projectQueuePath: tmpProjectQueue,
    });
    let tmpRaw = "";
    try {
      tmpRaw = await fs.readFile(tmpQueue, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    let tmpProjectRaw = "";
    if (tmpProjectQueue) {
      try {
        tmpProjectRaw = await fs.readFile(tmpProjectQueue, "utf8");
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
    rebuilt = {
      buckets: tmpCursors.hourly.buckets || {},
      groupQueued: tmpCursors.hourly.groupQueued || {},
      codexHashes: Array.isArray(tmpCursors.codexHashes) ? tmpCursors.codexHashes : [],
      files: tmpCursors.files || {},
      queueRows: tmpRaw.split("\n").filter((l) => l.trim()),
      projectHourly: tmpCursors.projectHourly || null,
      projectQueueRows: tmpProjectRaw.split("\n").filter((l) => l.trim()),
    };
  } catch (e) {
    console.error(
      "[sync] codex rescan repair: rebuild failed, leaving all data untouched:",
      e?.message || e,
    );
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
    if (tmpProjectQueue) await fs.rm(tmpProjectQueue, { force: true }).catch(() => {});
  }

  // SANITY: codex files exist on disk but the rebuild produced no codex buckets
  // → treat as a failed rebuild and skip (do NOT clear live data, do NOT set the
  // key — retry next sync).
  const rebuiltCodexKeys = Object.keys(rebuilt.buckets).filter((k) => k.startsWith("codex|"));
  if (codexFiles.length > 0 && rebuiltCodexKeys.length === 0) {
    console.error(
      `[sync] codex rescan repair: rebuild produced 0 codex buckets from ${codexFiles.length} files — skipping to avoid data loss`,
    );
    return false;
  }
  if (projectRepairEnabled) {
    const malformedProjectRows = await countMalformedCodexProjectQueueRows(projectQueuePath);
    if (malformedProjectRows > 0) {
      console.error(
        `[sync] codex rescan repair: found ${malformedProjectRows} malformed codex project queue row(s) — skipping to avoid data loss`,
      );
      return false;
    }

    const existingProjectKeys = new Set([
      ...(await projectUsageKeysFromQueuePath(projectQueuePath, "codex")),
      ...projectUsageKeysFromState(cursors.projectHourly, "codex"),
    ]);
    const rebuiltProjectKeys = new Set([
      ...projectUsageKeysFromQueueRows(rebuilt.projectQueueRows, "codex"),
      ...projectUsageKeysFromState(rebuilt.projectHourly, "codex"),
    ]);
    const missingProjectKeys = [...existingProjectKeys].filter((key) => !rebuiltProjectKeys.has(key));
    if (missingProjectKeys.length > 0) {
      console.error(
        `[sync] codex rescan repair: project rebuild missed ${missingProjectKeys.length} existing codex project bucket(s) — skipping to avoid data loss`,
      );
      return false;
    }

    const existingProjectTotals = mergeMaxTotals(
      await projectUsageTotalsFromQueuePath(projectQueuePath, "codex"),
      projectUsageTotalsFromState(cursors.projectHourly, "codex"),
    );
    const rebuiltProjectTotals = mergeMaxTotals(
      projectUsageTotalsFromQueueRows(rebuilt.projectQueueRows, "codex"),
      projectUsageTotalsFromState(rebuilt.projectHourly, "codex"),
    );
    const existingMainHourTotals = mergeMaxTotals(
      await mainUsageHourTotalsFromQueuePath(queuePath, "codex"),
      mainUsageHourTotalsFromState(cursors.hourly, "codex"),
    );
    const rebuiltMainHourTotals = mergeMaxTotals(
      mainUsageHourTotalsFromQueueRows(rebuilt.queueRows, "codex"),
      mainUsageHourTotalsFromState({ buckets: rebuilt.buckets }, "codex"),
    );
    const partialProjectKeys = [];
    for (const [key, existingTotal] of existingProjectTotals.entries()) {
      const rebuiltTotal = rebuiltProjectTotals.get(key);
      if (!Number.isFinite(rebuiltTotal) || rebuiltTotal >= existingTotal) continue;
      const [, source, hourStart] = key.split("|");
      const mainKey = `${source}|${hourStart}`;
      const existingMainTotal = existingMainHourTotals.get(mainKey) || 0;
      const rebuiltMainTotal = rebuiltMainHourTotals.get(mainKey) || 0;
      if (rebuiltMainTotal >= existingMainTotal) partialProjectKeys.push(key);
    }
    if (partialProjectKeys.length > 0) {
      console.error(
        `[sync] codex rescan repair: project rebuild lowered ${partialProjectKeys.length} existing codex project bucket(s) without a matching main-bucket repair — skipping to avoid data loss`,
      );
      return false;
    }
  }

  // COMMIT (only after a verified rebuild). A crash partway just leaves the
  // migration to re-run next sync — re-rebuild + re-strip + re-commit converges.
  //
  // 1. queue.jsonl: drop the inflated codex rows, append the clean rebuilt ones
  //    (atomic tmp+rename). With no old-high codex rows left, the cloud ingest's
  //    within-batch MAX keeps nothing larger and its overwrite-upsert replaces
  //    the inflated cloud rows on the next upload.
  if (typeof queuePath === "string" && queuePath) {
    let raw = "";
    try {
      raw = await fs.readFile(queuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const kept = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        kept.push(line);
        continue;
      }
      if (row?.source === "codex") continue;
      kept.push(line);
    }
    await ensureDir(path.dirname(queuePath));
    const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, kept.concat(rebuilt.queueRows).join("\n") + "\n", "utf8");
    await fs.rename(tmp, queuePath);
  }

  // 2. Swap the live codex hourly state for the rebuilt one, and install the
  //    rebuilt per-file cursors (offset at EOF) so the later parse in THIS sync
  //    does not re-read codex (which would re-inflate project buckets).
  const hourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};
  for (const k of Object.keys(hourly.buckets)) {
    if (k.startsWith("codex|")) delete hourly.buckets[k];
  }
  for (const k of Object.keys(hourly.groupQueued)) {
    if (k.startsWith("codex|")) delete hourly.groupQueued[k];
  }
  for (const [k, v] of Object.entries(rebuilt.buckets)) {
    if (k.startsWith("codex|")) hourly.buckets[k] = v;
  }
  for (const [k, v] of Object.entries(rebuilt.groupQueued)) {
    if (k.startsWith("codex|")) hourly.groupQueued[k] = v;
  }
  cursors.files ||= {};
  for (const fp of Object.keys(cursors.files)) {
    if (isCodexSessionCursorPath(fp)) delete cursors.files[fp];
  }
  for (const [fp, v] of Object.entries(rebuilt.files)) {
    cursors.files[fp] = v;
  }
  cursors.codexHashes = rebuilt.codexHashes;

  // 3. Project usage mirrors the main Codex repair: drop inflated Codex project
  //    rows, append the rebuilt rows, and swap only Codex project buckets. Project
  //    metadata is merged so visibility/purge state from non-Codex sources stays.
  if (projectRepairEnabled) {
    let projectRaw = "";
    try {
      projectRaw = await fs.readFile(projectQueuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const keptProjectRows = [];
    for (const line of projectRaw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        keptProjectRows.push(line);
        continue;
      }
      if (row?.source === "codex") continue;
      keptProjectRows.push(line);
    }
    await ensureDir(path.dirname(projectQueuePath));
    const tmp = `${projectQueuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(
      tmp,
      keptProjectRows.concat(rebuilt.projectQueueRows).join("\n") + "\n",
      "utf8",
    );
    await fs.rename(tmp, projectQueuePath);

    const projectHourly = (cursors.projectHourly ||= { version: 2, buckets: {}, projects: {} });
    projectHourly.version = 2;
    projectHourly.buckets ||= {};
    projectHourly.projects ||= {};
    for (const [key, bucket] of Object.entries(projectHourly.buckets)) {
      const source = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
      if (source === "codex") delete projectHourly.buckets[key];
    }
    const rebuiltProjectHourly = rebuilt.projectHourly || {};
    for (const [key, bucket] of Object.entries(rebuiltProjectHourly.buckets || {})) {
      const source = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
      if (source === "codex") projectHourly.buckets[key] = bucket;
    }
    for (const [key, meta] of Object.entries(rebuiltProjectHourly.projects || {})) {
      if (meta && typeof meta === "object") projectHourly.projects[key] = meta;
    }
    projectHourly.updatedAt = new Date().toISOString();
  }

  // 4. Reset the cloud upload offset so the corrected queue re-uploads. Other
  //    sources re-upsert idempotently (last emission per key wins).
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_codex_rescan_dedup_2026_06";
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }
  if (projectRepairEnabled && typeof projectQueueStatePath === "string" && projectQueueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(projectQueueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_codex_rescan_dedup_2026_06";
    await fs.writeFile(projectQueueStatePath, JSON.stringify(uploadState));
  }

  migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY] = new Date().toISOString();
  return true;
}

function isCodexSessionCursorPath(filePath) {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/");
  return /\/\.codex\/(?:archived_)?sessions\//.test(normalized);
}

async function projectUsageKeysFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return [];
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return [];
  }
  return projectUsageKeysFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function projectUsageKeysFromQueueRows(rows, source) {
  const keys = [];
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (key && row?.source === source) keys.push(key);
  }
  return keys;
}

function projectUsageKeysFromState(projectState, source) {
  const buckets =
    projectState && typeof projectState === "object" && projectState.buckets
      ? projectState.buckets
      : {};
  const keys = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
    if (bucketSource !== source) continue;
    const usageKey =
      projectUsageKeyFromFields({
        projectKey: bucket?.project_key,
        source: bucketSource,
        hourStart: bucket?.hour_start,
      }) || key;
    keys.push(usageKey);
  }
  return keys;
}

function projectUsageKeyFromFields({ projectKey, source, hourStart }) {
  if (
    typeof projectKey !== "string" ||
    typeof source !== "string" ||
    typeof hourStart !== "string" ||
    !projectKey ||
    !source ||
    !hourStart
  ) {
    return null;
  }
  return `${projectKey}|${source}|${hourStart}`;
}

async function countMalformedCodexProjectQueueRows(queuePath) {
  if (typeof queuePath !== "string" || !queuePath) return 0;
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (row?.source !== "codex") continue;
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (!key) count += 1;
  }
  return count;
}

async function projectUsageTotalsFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return new Map();
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return new Map();
  }
  return projectUsageTotalsFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function projectUsageTotalsFromQueueRows(rows, source) {
  const totals = new Map();
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (!key || row?.source !== source) continue;
    setMaxTotal(totals, key, Number(row.total_tokens || 0));
  }
  return totals;
}

function projectUsageTotalsFromState(projectState, source) {
  const buckets =
    projectState && typeof projectState === "object" && projectState.buckets
      ? projectState.buckets
      : {};
  const totals = new Map();
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
    if (bucketSource !== source) continue;
    const usageKey =
      projectUsageKeyFromFields({
        projectKey: bucket?.project_key,
        source: bucketSource,
        hourStart: bucket?.hour_start,
      }) || key;
    setMaxTotal(totals, usageKey, Number(bucket?.totals?.total_tokens || 0));
  }
  return totals;
}

async function mainUsageHourTotalsFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return new Map();
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return new Map();
  }
  return mainUsageHourTotalsFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function mainUsageHourTotalsFromQueueRows(rows, source) {
  const modelTotals = new Map();
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (row?.source !== source || typeof row?.hour_start !== "string") continue;
    const model = typeof row?.model === "string" && row.model ? row.model : "unknown";
    setMaxTotal(modelTotals, `${row.source}|${model}|${row.hour_start}`, Number(row.total_tokens || 0));
  }
  return collapseModelTotalsByHour(modelTotals);
}

function mainUsageHourTotalsFromState(hourlyState, source) {
  const buckets =
    hourlyState && typeof hourlyState === "object" && hourlyState.buckets
      ? hourlyState.buckets
      : {};
  const modelTotals = new Map();
  for (const [key, bucket] of Object.entries(buckets)) {
    const parts = key.split("|");
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : parts[0];
    if (bucketSource !== source) continue;
    const model = typeof bucket?.model === "string" && bucket.model ? bucket.model : parts[1] || "unknown";
    const hourStart =
      typeof bucket?.hour_start === "string" && bucket.hour_start ? bucket.hour_start : parts[2];
    if (typeof hourStart !== "string" || !hourStart) continue;
    setMaxTotal(modelTotals, `${bucketSource}|${model}|${hourStart}`, Number(bucket?.totals?.total_tokens || 0));
  }
  return collapseModelTotalsByHour(modelTotals);
}

function collapseModelTotalsByHour(modelTotals) {
  const totals = new Map();
  for (const [key, total] of modelTotals.entries()) {
    const [source, , hourStart] = key.split("|");
    const hourKey = `${source}|${hourStart}`;
    totals.set(hourKey, (totals.get(hourKey) || 0) + total);
  }
  return totals;
}

function mergeMaxTotals(...maps) {
  const merged = new Map();
  for (const map of maps) {
    if (!(map instanceof Map)) continue;
    for (const [key, total] of map.entries()) {
      setMaxTotal(merged, key, total);
    }
  }
  return merged;
}

function setMaxTotal(map, key, total) {
  if (!key || !Number.isFinite(total)) return;
  const prev = map.get(key);
  if (!Number.isFinite(prev) || total > prev) map.set(key, total);
}

// One-time repair (#204): when the SAME Droid session id existed in two folders
// under ~/.factory/sessions, parseDroidIncremental's cumulative-delta loop made the
// lower-count file look like a reset and re-emitted each duplicate's full total on
// EVERY sync, inflating one (droid, model, hour) bucket without bound (a real ~10M
// session showed as 40.06B). The forward fix is dedupeDroidSettingsFilesBySession
// inside the parser; this migration repairs already-polluted installs.
//
// SCOPE — strictly the duplicate sessions' buckets, and ONLY when duplicate files
// still exist on disk:
//   * A from-zero rebuild cannot reconstruct Droid's historical per-sync bucket
//     distribution — settings.json carries only the CURRENT mtime, not per-turn
//     timestamps like Codex's jsonl. So we rebuild over the DUPLICATE files only,
//     and overwrite only the bucket keys those files map to (pollutedKeys) plus
//     the duplicate sessions' cursor entries. Every other droid bucket and cursor
//     — clean sessions AND deleted-session history — is left byte-for-byte intact,
//     so healthy history is never collapsed into the current half-hour.
//   * No session id has >1 file on disk → this bug never fired here: set the
//     sentinel, touch nothing.
//   * Fire only when live > rebuilt over pollutedKeys (actual inflation), so a
//     fresh install (live empty) is left to the normal same-sync parse.
// Droid has no project dimension, so project.queue.jsonl is never involved.
async function repairDroidDuplicateSessionInflation({ cursors, queuePath, queueStatePath } = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  // Completed run → truthy non-skip sentinel (final). A {skipped:true} object would
  // retry (codex skip-retry semantics; this repair only ever writes done/none).
  const prior = migrations[DROID_DUP_SESSION_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  // Group current on-disk settings files by session id; collect duplicates.
  let onDisk;
  try {
    onDisk = listDroidSettingsFiles(process.env);
  } catch {
    onDisk = [];
  }
  const bySession = new Map();
  for (const fp of onDisk) {
    const sid = droidSessionIdFromPath(fp);
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(fp);
  }
  const dupFiles = [];
  const cleanFiles = [];
  for (const group of bySession.values()) {
    if (group.length > 1) dupFiles.push(...group);
    else cleanFiles.push(...group);
  }
  if (dupFiles.length === 0) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // Map on-disk settings files to the (droid, model, half-hour) bucket keys they
  // emit under the parser's own keying (mirrors parseDroidIncremental).
  const bucketKeysForFiles = (files) => {
    const keys = new Set();
    for (const fp of files) {
      let mtimeMs = 0;
      try {
        mtimeMs = fssync.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      let settings;
      try {
        settings = JSON.parse(fssync.readFileSync(fp, "utf8"));
      } catch {
        continue;
      }
      if (!settings || typeof settings !== "object" || !settings.tokenUsage) continue;
      const bucketStart = toUtcHalfHourStart(
        new Date(mtimeMs || Date.now()).toISOString(),
      );
      if (!bucketStart) continue;
      keys.add(bucketKey("droid", resolveDroidModel(settings, fp), bucketStart));
    }
    return keys;
  };

  // A bucket key is (source, model, half-hour) — it carries NO session identity.
  // pollutedKeys are the buckets the duplicate files emit to; cleanKeys are buckets
  // a NON-duplicate on-disk session emits to. When a clean session resolves to the
  // same (model, half-hour) as a duplicate file, they collide on one key. We must
  // NOT delete-and-replace such a shared bucket: the rebuild runs over duplicate
  // files only, so replacing the bucket would erase the clean session's tokens
  // (silent data loss). So repair ONLY buckets owned exclusively by duplicate
  // sessions; leave shared buckets intact. Residual inflation in a rare shared
  // bucket is visible and recoverable; destroying real data is not (this is the
  // dedup-needs-identity-proof rule).
  const pollutedKeys = bucketKeysForFiles(dupFiles);
  const cleanKeys = bucketKeysForFiles(cleanFiles);
  const repairKeys = new Set();
  for (const k of pollutedKeys) if (!cleanKeys.has(k)) repairKeys.add(k);
  if (repairKeys.size === 0) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // Ground-truth rebuild into throwaway state over the DUPLICATE files only
  // (parseDroidIncremental de-dupes its own input → canonical per session). On any
  // throw, leave all state untouched and do NOT set the sentinel (retry next sync).
  let rebuilt;
  const tmpQueue = `${queuePath}.droidrebuild.${process.pid}.${Date.now()}`;
  try {
    const tmpCursors = { hourly: { buckets: {}, groupQueued: {} }, droid: {} };
    await parseDroidIncremental({
      settingsFiles: dupFiles,
      cursors: tmpCursors,
      queuePath: tmpQueue,
      env: process.env,
      prune: true,
    });
    let tmpRaw = "";
    try {
      tmpRaw = await fs.readFile(tmpQueue, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    rebuilt = {
      buckets: tmpCursors.hourly.buckets || {},
      sessionTotals: (tmpCursors.droid && tmpCursors.droid.sessionTotals) || {},
      queueRows: tmpRaw.split("\n").filter((l) => l.trim()),
    };
  } catch (e) {
    console.error(
      "[sync] droid dup-session repair: rebuild failed, leaving all data untouched:",
      e?.message || e,
    );
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
  }

  // Inflation present? Compare live vs rebuilt totals over the repair-scoped keys
  // only. Fire only on live > rebuilt (real inflation) — never on a fresh install
  // (live 0).
  const liveBuckets = (cursors.hourly && cursors.hourly.buckets) || {};
  let liveScoped = 0;
  let rebuiltScoped = 0;
  for (const key of repairKeys) {
    liveScoped += Number(liveBuckets[key]?.totals?.total_tokens || 0);
    rebuiltScoped += Number(rebuilt.buckets[key]?.totals?.total_tokens || 0);
  }
  if (liveScoped <= rebuiltScoped) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // ── COMMIT (atomic) ──
  await ensureDir(path.dirname(queuePath));
  await backupExistingFile(queuePath);

  // 1. queue.jsonl: keep every non-droid line verbatim (incl. unparseable) and
  //    every droid row whose bucket key is NOT in repairKeys (clean + shared +
  //    deleted-session history). Drop droid rows in repairKeys; append rebuilt rows.
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  // A queue line is in scope if it's a droid row whose bucket is in repairKeys.
  // Unparseable / non-droid / clean / shared droid rows are kept verbatim.
  const isRepairDroidRow = (line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    return (
      row?.source === "droid" &&
      repairKeys.has(bucketKey("droid", row.model, row.hour_start))
    );
  };
  const kept = raw
    .split("\n")
    .filter((line) => line.trim() && !isRepairDroidRow(line));
  const rebuiltRepairRows = rebuilt.queueRows.filter(isRepairDroidRow);
  const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(
    tmp,
    kept.concat(rebuiltRepairRows).join("\n") + "\n",
    "utf8",
  );
  await fs.rename(tmp, queuePath);

  // 2. live hourly buckets: delete repair-scoped droid keys, install the rebuilt
  //    buckets for those keys. Other droid buckets untouched.
  const hourly = (cursors.hourly ||= { version: 3, buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};
  for (const key of repairKeys) {
    delete hourly.buckets[key];
    if (rebuilt.buckets[key]) hourly.buckets[key] = rebuilt.buckets[key];
  }
  // Defensive: droid never uses the legacy aggregate path, but drop any stale droid
  // group markers so a repaired hour can't re-emit as model=unknown.
  for (const gk of Object.keys(hourly.groupQueued)) {
    if (gk.startsWith("droid|")) delete hourly.groupQueued[gk];
  }

  // 3. session cursor: overwrite ONLY the duplicate sessions with the ground-truth
  //    rebuild so the later same-sync droid parse short-circuits (mtime match) and
  //    emits nothing. Clean sessions' cursor entries are correct already — leave
  //    them, or the later parse would re-emit them from zero.
  const droidState = (cursors.droid ||= {});
  if (!droidState.sessionTotals || typeof droidState.sessionTotals !== "object") {
    droidState.sessionTotals = {};
  }
  for (const sid of Object.keys(rebuilt.sessionTotals)) {
    droidState.sessionTotals[sid] = rebuilt.sessionTotals[sid];
  }
  droidState.updatedAt = new Date().toISOString();

  // 4. reset the cloud upload offset so corrected rows re-upload (idempotent upsert).
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_droid_dup_session_2026_06";
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }

  migrations[DROID_DUP_SESSION_REPAIR_KEY] = {
    status: "done",
    at: new Date().toISOString(),
    keysRepaired: repairKeys.size,
    keysSkippedSharedWithCleanSession: pollutedKeys.size - repairKeys.size,
    liveBefore: liveScoped,
    rebuiltAfter: rebuiltScoped,
    deltaReclaimed: liveScoped - rebuiltScoped,
  };
  return true;
}

// One-time repair migration: rebuild source=claude rows in queue.jsonl from
// the actual jsonl files using ccusage's algorithm (msgId+reqId global
// dedup). Earlier `reincludeClaudeMemObserverFiles` versions (v1/v2/v3) each
// reset the hash set and re-read observer jsonls, which silently inflated
// queue.jsonl's claude totals by ~40%. We do an atomic rewrite — keep all
// non-claude rows verbatim, replace every claude/claude-mem row with the
// ground-truth set — then reset cursors so the next incremental sync stays
// in sync, and reset the cloud upload offset so the corrected rows actually
// reach the cloud (the ingest endpoint upserts by (source, model,
// hour_start), so re-uploading other sources is idempotent).
async function repairClaudeQueueFromGroundTruth({
  cursors,
  queuePath,
  queueStatePath = null,
  projectQueuePath = null,
  projectQueueStatePath = null,
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[CLAUDE_GROUND_TRUTH_REPAIR_KEY]) return false;

  let result;
  try {
    result = await computeClaudeGroundTruthBuckets();
  } catch (e) {
    console.error("[sync] claude ground-truth repair: scan failed:", e?.message || e);
    return false;
  }
  const { rows, seenHashes, fileList } = result;

  // 1. Atomic rewrite of queue.jsonl: keep non-claude rows, drop existing
  //    claude/claude-mem rows, append truth rows. Atomic via tmp + rename.
  let claudeRowsRemoved = 0;
  if (typeof queuePath === "string" && queuePath) {
    let raw = "";
    try {
      raw = await fs.readFile(queuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const keptLines = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        // Preserve unparseable lines verbatim — operator may want to
        // recover them later.
        keptLines.push(line);
        continue;
      }
      if (row?.source === "claude" || row?.source === "claude-mem") {
        claudeRowsRemoved += 1;
        continue;
      }
      keptLines.push(line);
    }

    const truthLines = rows.map((r) =>
      JSON.stringify({
        source: "claude",
        model: r.model,
        hour_start: r.hour_start,
        input_tokens: r.input_tokens,
        cached_input_tokens: r.cached_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        output_tokens: r.output_tokens,
        reasoning_output_tokens: r.reasoning_output_tokens,
        total_tokens: r.total_tokens,
        billable_total_tokens: r.billable_total_tokens,
        conversation_count: r.conversation_count,
      }),
    );

    await ensureDir(path.dirname(queuePath));
    const out = keptLines.concat(truthLines).join("\n") + "\n";
    const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, out, "utf8");
    await fs.rename(tmp, queuePath);
  }

  // 2. Reset cursors.hourly.buckets / groupQueued for source=claude (and the
  //    dead source=claude-mem buckets) so incremental sync's in-memory state
  //    matches the truth.
  const hourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};

  let bucketsCleared = 0;
  for (const k of Object.keys(hourly.buckets)) {
    if (k.startsWith("claude|") || k.startsWith("claude-mem|")) {
      delete hourly.buckets[k];
      bucketsCleared += 1;
    }
  }
  // Clear stale claude entries from groupQueued (left over by v2 repair).
  // After v3 we never repopulate it for claude, so nothing should be added
  // back during the per-model write loop below.
  for (const k of Object.keys(hourly.groupQueued)) {
    if (k.startsWith("claude|") || k.startsWith("claude-mem|")) {
      delete hourly.groupQueued[k];
    }
  }

  // Per-model claude buckets: set queuedKey but DO NOT touch
  // hourly.groupQueued. groupQueued is used by enqueueTouchedBuckets to
  // mark a (source, hour) as legacy-aggregate state; writing claude hours
  // there would force every later sync to re-emit the hour as a single
  // model=DEFAULT_MODEL aggregate row instead of touching only the bucket
  // that actually changed. The original v2 release did write groupQueued
  // here and was the cause of an unknown-bucket inflation regression.
  for (const r of rows) {
    const totals = {
      input_tokens: r.input_tokens,
      cached_input_tokens: r.cached_input_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      output_tokens: r.output_tokens,
      reasoning_output_tokens: r.reasoning_output_tokens,
      total_tokens: r.total_tokens,
      billable_total_tokens: r.billable_total_tokens,
      conversation_count: r.conversation_count,
    };
    const key = bucketKey("claude", r.model, r.hour_start);
    hourly.buckets[key] = {
      totals,
      queuedKey: totalsKey(totals),
      source: "claude",
      hour_start: r.hour_start,
    };
  }

  // 3. Reset per-file cursors so future incremental sync only reads genuinely
  //    new tail content. Format must match what rollout.js expects:
  //    { inode, offset, updatedAt }. Setting a plain integer here breaks
  //    the inode-equality check inside parseClaudeFile, which would treat
  //    the file as untracked and re-read it from byte 0 — silently doubling
  //    everything. (That was the actual cause of the regression after the
  //    first repair attempt.)
  cursors.files ||= {};
  let filesReset = 0;
  const nowIso = new Date().toISOString();
  for (const fp of fileList) {
    let st;
    try {
      st = fssync.statSync(fp);
    } catch (_e) {
      continue;
    }
    cursors.files[fp] = {
      inode: st.ino || 0,
      offset: st.size,
      updatedAt: nowIso,
    };
    filesReset += 1;
  }
  cursors.claudeHashes = seenHashes;

  // 4. Reset cloud-upload offset so the corrected rows are re-sent. Other
  //    sources are upserted idempotently by the ingest endpoint, so this is
  //    safe — just costs one extra round of bandwidth.
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_claude_repair_2026_05_v4";
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }

  // 5. Repair project queue. Historical claude rows in project.queue.jsonl
  //    were uniformly mis-attributed to project_key=
  //    "claude-mem/observer-sessions" (left over from the observer
  //    relabel migration). We can't reconstruct the true cwd-based
  //    project_key for each historical message reliably, so we drop every
  //    claude/claude-mem row from project.queue.jsonl and reset the
  //    matching cursors.projectHourly state. New claude usage will
  //    accumulate to the correct cwd-derived project_key going forward.
  let projectRowsRemoved = 0;
  let projectBucketsCleared = 0;
  if (typeof projectQueuePath === "string" && projectQueuePath) {
    let projRaw = "";
    try {
      projRaw = await fs.readFile(projectQueuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    if (projRaw) {
      const projKept = [];
      for (const line of projRaw.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch (_e) {
          projKept.push(line);
          continue;
        }
        if (row?.source === "claude" || row?.source === "claude-mem") {
          projectRowsRemoved += 1;
          continue;
        }
        projKept.push(line);
      }
      await ensureDir(path.dirname(projectQueuePath));
      const tmp = `${projectQueuePath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, projKept.join("\n") + "\n", "utf8");
      await fs.rename(tmp, projectQueuePath);
    }

    // Clear matching projectHourly state so the claude project buckets
    // start fresh.
    const projHourly = (cursors.projectHourly ||= { buckets: {} });
    projHourly.buckets ||= {};
    for (const k of Object.keys(projHourly.buckets)) {
      const v = projHourly.buckets[k];
      const src = v?.source || "";
      if (src === "claude" || src === "claude-mem") {
        delete projHourly.buckets[k];
        projectBucketsCleared += 1;
      }
    }

    // Reset project upload offset.
    if (typeof projectQueueStatePath === "string" && projectQueueStatePath) {
      let st = {};
      try {
        st = JSON.parse(await fs.readFile(projectQueueStatePath, "utf8"));
      } catch (_e) {
        st = {};
      }
      st.offset = 0;
      st.updatedAt = new Date().toISOString();
      st.note = "reset_after_claude_repair_2026_05_v6";
      await fs.writeFile(projectQueueStatePath, JSON.stringify(st));
    }
  }

  migrations[CLAUDE_GROUND_TRUTH_REPAIR_KEY] = {
    appliedAt: new Date().toISOString(),
    bucketsWritten: rows.length,
    bucketsCleared,
    rowsRemoved: claudeRowsRemoved,
    filesReset,
    hashesRetained: seenHashes.length,
    uploadOffsetReset: typeof queueStatePath === "string" && !!queueStatePath,
    projectRowsRemoved,
    projectBucketsCleared,
  };
  return true;
}

async function reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath, queueStatePath }) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[CLAUDE_MEM_OBSERVER_REINCLUDE_KEY]) return false;

  const observerPaths = (Array.isArray(claudeFiles) ? claudeFiles : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((p) => typeof p === "string" && p.includes(CLAUDE_MEM_OBSERVER_PATH_SEGMENT));

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  let filesReset = 0;
  for (const filePath of observerPaths) {
    if (cursors.files[filePath]) {
      delete cursors.files[filePath];
      filesReset += 1;
    }
  }

  const hashesToRemove = observerPaths.length > 0
    ? await collectClaudeMessageHashes(observerPaths)
    : new Set();
  let hashesRemoved = 0;
  if (Array.isArray(cursors.claudeHashes) && hashesToRemove.size > 0) {
    const nextHashes = [];
    for (const hash of cursors.claudeHashes) {
      if (hashesToRemove.has(hash)) {
        hashesRemoved += 1;
        continue;
      }
      nextHashes.push(hash);
    }
    cursors.claudeHashes = nextHashes;
  }

  const queueRowsRelabeled = typeof queuePath === "string" && queuePath
    ? await relabelClaudeMemQueueRows(queuePath, queueStatePath)
    : 0;

  migrations[CLAUDE_MEM_OBSERVER_REINCLUDE_KEY] = {
    appliedAt: new Date().toISOString(),
    filesReset,
    hashesRemoved,
    queueRowsRelabeled,
  };
  return filesReset > 0 || hashesRemoved > 0 || queueRowsRelabeled > 0;
}

async function relabelClaudeMemQueueRows(queuePath, queueStatePath = null) {
  let raw;
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (_e) {
    return 0;
  }
  if (!raw || !raw.includes('"claude-mem"')) return 0;

  // The cloud-upload cursor (queue.state.json `offset`) is a byte position in
  // the pre-rewrite file. Relabeling shrinks rewritten lines ("claude-mem" →
  // "claude"), so the old offset would land mid-line in the new file and the
  // next drainQueueToCloud batch would skip part of a row (or a whole row).
  // Track the old→new byte mapping while rewriting and remap the offset to
  // the equivalent line boundary (same pattern as project-usage-purge.js).
  let previousOffset = 0;
  if (typeof queueStatePath === "string" && queueStatePath) {
    try {
      const st = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      const off = Number(st?.offset || 0);
      if (Number.isFinite(off) && off > 0) previousOffset = off;
    } catch (_e) {
      previousOffset = 0;
    }
  }

  const lines = raw.split("\n");
  const out = [];
  let relabeled = 0;
  let inputOffset = 0;
  let outputOffset = 0;
  let nextOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    let outLine = line;
    if (line) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.source === "claude-mem") {
          obj.source = "claude";
          relabeled += 1;
          outLine = JSON.stringify(obj);
        }
      } catch (_e) {
        // keep malformed lines verbatim
      }
    }
    out.push(outLine);
    inputOffset += Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
    outputOffset += Buffer.byteLength(outLine, "utf8") + (isLast ? 0 : 1);
    // Upload offsets always sit at line boundaries; a mid-line offset
    // (corruption) rounds down to the previous boundary so no row is skipped
    // — worst case a row is re-uploaded, and cloud ingest upserts by key.
    if (inputOffset <= previousOffset) nextOffset = outputOffset;
  }
  if (relabeled === 0) return 0;

  // Atomic rewrite: temp file in the same directory + rename, so a crash
  // mid-write can never leave queue.jsonl truncated.
  const tmpPath = `${queuePath}.tmp`;
  await fs.writeFile(tmpPath, out.join("\n"), "utf8");
  await fs.rename(tmpPath, queuePath);

  if (typeof queueStatePath === "string" && queueStatePath && previousOffset > 0) {
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      if (!state || typeof state !== "object") state = {};
    } catch (_e) {
      state = {};
    }
    state.offset = nextOffset;
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(queueStatePath, JSON.stringify(state), "utf8");
  }
  return relabeled;
}

async function collectClaudeMessageHashes(filePaths) {
  const hashes = new Set();
  for (const filePath of filePaths) {
    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8" });
    } catch (_e) {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      const hash = claudeMessageDedupKey(obj);
      if (hash) hashes.add(hash);
    }
    rl.close();
    stream.close?.();
  }
  return hashes;
}
