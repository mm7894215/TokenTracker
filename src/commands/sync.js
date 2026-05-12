const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const cp = require("node:child_process");
const readline = require("node:readline");

const { ensureDir, readJson, writeJson, openLock } = require("../lib/fs");
const {
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
  parseKimiIncremental,
  resolveOmpSessionFiles,
  parseOmpIncremental,
  resolvePiSessionFiles,
  parsePiIncremental,
  piAgentDirCollidesWithOmp,
  resolveCraftSessionFiles,
  parseCraftIncremental,
  resolveCodebuddyProjectFiles,
  parseCodebuddyIncremental,
  resolveKiroCliSessionFiles,
  resolveKiroCliDbPath,
  parseKiroCliIncremental,
  resolveKilocodeTaskFiles,
  parseKilocodeIncremental,
  bucketKey,
  totalsKey,
  groupBucketKey,
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
// way. v4 re-runs the same five-step atomic repair against the corrected
// `claudeMessageDedupKey()` (msgId is globally unique on its own per the
// Anthropic protocol, so the reqId requirement was always unnecessary).
const CLAUDE_GROUND_TRUTH_REPAIR_KEY = "claudeGroundTruthRepair_2026_05_v4";

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

    const config = await readJson(configPath);
    const cursors = (await readJson(cursorsPath)) || { version: 1, files: {}, updatedAt: null };
    const uploadThrottle = normalizeUploadState(await readJson(uploadThrottlePath));
    let uploadThrottleState = uploadThrottle;

    const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
    const codeHome = process.env.CODE_HOME || path.join(home, ".code");
    const claudeProjectsDir = path.join(home, ".claude", "projects");
    const geminiHome = process.env.GEMINI_HOME || path.join(home, ".gemini");
    const geminiTmpDir = path.join(geminiHome, "tmp");
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const opencodeHome = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
    const opencodeStorageDir = path.join(opencodeHome, "storage");
    const kiloHome = process.env.KILO_HOME || path.join(xdgDataHome, "kilo");

    // OpenClaw hook integration: allow a hook to request incremental parsing for a single session jsonl.
    // We still parse all regular sources so model/source attribution stays complete (e.g. Kimi sessions).
    const openclawSignal = opts.fromOpenclaw
      ? resolveOpenclawSignal({ home, env: process.env })
      : null;

    const sources = [
      { source: "codex", sessionsDir: path.join(codexHome, "sessions") },
      { source: "every-code", sessionsDir: path.join(codeHome, "sessions") },
    ];

    const rolloutFiles = [];
    const seenSessions = new Set();
    for (const entry of sources) {
      if (seenSessions.has(entry.sessionsDir)) continue;
      seenSessions.add(entry.sessionsDir);
      const files = await listRolloutFiles(entry.sessionsDir);
      for (const filePath of files) {
        rolloutFiles.push({ path: filePath, source: entry.source });
      }
    }

    await migrateRolloutCumulativeDeltaBuckets({ cursors, queuePath, rolloutFiles });

    const openclawFiles = openclawSignal?.sessionFile
      ? [{ path: openclawSignal.sessionFile, source: "openclaw" }]
      : [];

    if (progress?.enabled) {
      progress.start(
        `Parsing ${renderBar(0)} 0/${formatNumber(rolloutFiles.length)} files | buckets 0`,
      );
    }

    const parseResult = await parseRolloutIncremental({
      rolloutFiles,
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

    let openclawResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (openclawFiles.length > 0) {
      // Only runs when explicitly triggered by OpenClaw hooks.
      openclawResult = await parseOpenclawIncremental({
        sessionFiles: openclawFiles,
        cursors,
        queuePath,
        projectQueuePath,
        source: "openclaw",
      });
    }

    const openclawFallback = await applyOpenclawTotalsFallback({
      trackerDir,
      signal: openclawSignal,
      cursors,
      queuePath,
      projectQueuePath,
    });
    openclawResult.filesProcessed += openclawFallback.filesProcessed;
    openclawResult.eventsAggregated += openclawFallback.eventsAggregated;
    openclawResult.bucketsQueued += openclawFallback.bucketsQueued;

    const claudeFiles = await listClaudeProjectFiles(claudeProjectsDir);
    await reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath });
    await repairClaudeQueueFromGroundTruth({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    });
    let claudeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (claudeFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Claude ${renderBar(0)} 0/${formatNumber(claudeFiles.length)} files | buckets 0`,
        );
      }
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
    }

    const geminiFiles = await listGeminiSessionFiles(geminiTmpDir);
    let geminiResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (geminiFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Gemini ${renderBar(0)} 0/${formatNumber(geminiFiles.length)} files | buckets 0`,
        );
      }
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
    }

    const opencodeFiles = await listOpencodeMessageFiles(opencodeStorageDir);
    let opencodeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (opencodeFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Opencode ${renderBar(0)} 0/${formatNumber(opencodeFiles.length)} files | buckets 0`,
        );
      }
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
    }

    // OpenCode v1.2+ stores messages in SQLite (opencode.db) instead of JSON files.
    const opencodeDbPath = path.join(opencodeHome, "opencode.db");
    let opencodeDbResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const dbMessages = readOpencodeDbMessages(opencodeDbPath);
    if (dbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Opencode DB ${renderBar(0)} 0/${formatNumber(dbMessages.length)} msgs | buckets 0`,
        );
      }
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
    const kiloDbMessages = readOpencodeDbMessages(kiloDbPath);
    if (kiloDbMessages.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Kilo CLI ${renderBar(0)} 0/${formatNumber(kiloDbMessages.length)} msgs | buckets 0`,
        );
      }
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
    }

    // ── Kilo Code VS Code extension (Cline-style ui_messages.json) ──
    const kilocodeTaskFiles = resolveKilocodeTaskFiles(process.env);
    let kilocodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (kilocodeTaskFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Kilo Code ${renderBar(0)} 0/${formatNumber(kilocodeTaskFiles.length)} tasks | buckets 0`,
        );
      }
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
    }

    // ── Cursor (API-based) ──
    // One-time migration: earlier CLI versions mis-parsed the Cursor CSV after
    // Cursor inserted new "Cloud Agent ID"/"Automation ID" columns, writing
    // cursor records under model="unknown". Purge those local buckets, emit
    // zero retractions so the cloud upserts overwrite them to zero, and reset
    // the incremental cursor so the fixed parser re-fetches all affected rows.
    await migrateCursorUnknownBuckets({ cursors, queuePath });

    let cursorResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (isCursorInstalled({ home })) {
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
    if (fssync.existsSync(kiroDbPath) || fssync.existsSync(kiroJsonlPath)) {
      if (progress?.enabled) {
        progress.start(`Parsing Kiro ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── Hermes Agent (SQLite-based) ──
    let hermesResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const hermesDbPath = resolveHermesDbPath();
    if (fssync.existsSync(hermesDbPath)) {
      if (progress?.enabled) {
        progress.start(`Parsing Hermes ${renderBar(0)} | buckets 0`);
      }
      hermesResult = await parseHermesIncremental({
        dbPath: hermesDbPath,
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
    const kiroCliSessionFiles = resolveKiroCliSessionFiles(process.env);
    if (fssync.existsSync(kiroCliDb) || kiroCliSessionFiles.length > 0) {
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
    const kimiWireFiles = resolveKimiWireFiles(process.env);
    if (kimiWireFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Kimi Code ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── CodeBuddy CLI (passive ~/.codebuddy/projects/**/*.jsonl reader) ──
    // Tencent's CodeBuddy CLI is a Claude Code clone; no hook system, so we
    // tail the per-session JSONL conversation logs incrementally on each sync.
    let codebuddyResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const codebuddyFiles = resolveCodebuddyProjectFiles(process.env);
    if (codebuddyFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing CodeBuddy ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── oh-my-pi (passive ~/.omp/agent/sessions/**/*.jsonl reader) ──
    let ompResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const ompFiles = resolveOmpSessionFiles(process.env);
    if (ompFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing oh-my-pi ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── pi (@mariozechner/pi-coding-agent) — passive ~/.pi/agent/sessions/**/*.jsonl reader ──
    // Skip pi parse if its agent dir resolves to the same path as omp's. This
    // prevents double-counting when explicit overrides (TOKENTRACKER_OMP_AGENT_DIR /
    // TOKENTRACKER_PI_AGENT_DIR) bypass the install-signal disambiguator.
    let piResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const piFiles = piAgentDirCollidesWithOmp(process.env)
      ? []
      : resolvePiSessionFiles(process.env);
    if (piFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing pi ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── Craft Agents (passive ~/.craft-agent + workspaces session.jsonl reader) ──
    let craftResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const craftFiles = resolveCraftSessionFiles(process.env);
    if (craftFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Craft ${renderBar(0)} | buckets 0`);
      }
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
    }

    // ── GitHub Copilot CLI (OTEL JSONL files) ──
    let copilotResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const copilotPaths = resolveCopilotOtelPaths(process.env);
    if (copilotPaths.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Copilot ${renderBar(0)} | buckets 0`);
      }
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
    }

    if (cursors?.projectHourly?.projects && projectQueuePath && projectQueueStatePath) {
      for (const [projectKey, meta] of Object.entries(cursors.projectHourly.projects)) {
        if (!meta || typeof meta !== "object") continue;
        if (meta.status !== "blocked" || !meta.purge_pending) continue;
        await purgeProjectUsage({
          projectKey,
          projectQueuePath,
          projectQueueStatePath,
          projectState: cursors.projectHourly,
        });
        meta.purge_pending = false;
        meta.purged_at = new Date().toISOString();
      }
    }

    cursors.updatedAt = new Date().toISOString();
    await writeJson(cursorsPath, cursors);

    progress?.stop();

    const runtime = resolveRuntimeConfig({ config: config || {}, env: process.env });

    let uploadResult = { inserted: 0, skipped: 0 };
    let uploadAttempted = false;

    if (runtime.deviceToken && runtime.baseUrl) {
      uploadAttempted = true;
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
    const projectAfterState = (await readJson(projectQueueStatePath)) || { offset: 0 };
    const projectQueueSize = await safeStatSize(projectQueuePath);
    const pendingBytes =
      Math.max(0, queueSize - Number(afterState.offset || 0)) +
      Math.max(0, projectQueueSize - Number(projectAfterState.offset || 0));

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
          source: "auto-backlog",
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
        opencodeResult.filesProcessed +
        cursorResult.recordsProcessed +
        kiroResult.recordsProcessed +
        kiroCliResult.recordsProcessed +
        hermesResult.recordsProcessed +
        kimiResult.recordsProcessed +
        codebuddyResult.recordsProcessed +
        ompResult.recordsProcessed +
        piResult.recordsProcessed +
        craftResult.recordsProcessed +
        copilotResult.recordsProcessed +
        kiloResult.messagesProcessed +
        kilocodeResult.recordsProcessed;
      const totalBuckets =
        parseResult.bucketsQueued +
        openclawResult.bucketsQueued +
        claudeResult.bucketsQueued +
        geminiResult.bucketsQueued +
        opencodeResult.bucketsQueued +
        cursorResult.bucketsQueued +
        kiroResult.bucketsQueued +
        kiroCliResult.bucketsQueued +
        hermesResult.bucketsQueued +
        kimiResult.bucketsQueued +
        codebuddyResult.bucketsQueued +
        ompResult.bucketsQueued +
        piResult.bucketsQueued +
        craftResult.bucketsQueued +
        copilotResult.bucketsQueued +
        kiloResult.bucketsQueued +
        kilocodeResult.bucketsQueued;
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
    drain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a === "--from-notify") out.fromNotify = true;
    else if (a === "--from-retry") out.fromRetry = true;
    else if (a === "--from-openclaw") out.fromOpenclaw = true;
    else if (a === "--drain") out.drain = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

module.exports = {
  cmdSync,
  migrateCursorUnknownBuckets,
  migrateRolloutCumulativeDeltaBuckets,
  reincludeClaudeMemObserverFiles,
  CURSOR_UNKNOWN_MIGRATION_KEY,
  ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY,
  CLAUDE_MEM_OBSERVER_REINCLUDE_KEY,
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
  autoRetryNoSpawn,
}) {
  const retryMs = coerceRetryMs(retryAtMs);
  if (!retryMs) return { scheduled: false, retryAtMs: 0 };

  const retryPath = path.join(trackerDir, AUTO_RETRY_FILENAME);
  const nowMs = Date.now();
  const existing = await readJson(retryPath);
  const existingMs = coerceRetryMs(existing?.retryAtMs);
  if (existingMs && existingMs >= retryMs - 1000) {
    return { scheduled: false, retryAtMs: existingMs };
  }

  const payload = {
    version: 1,
    retryAtMs: retryMs,
    retryAt: new Date(retryMs).toISOString(),
    reason: typeof reason === "string" && reason.length > 0 ? reason : "throttled",
    pendingBytes: Math.max(0, Number(pendingBytes || 0)),
    scheduledAt: new Date(nowMs).toISOString(),
    source: typeof source === "string" ? source : "auto",
  };

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
    `  let retryAtMs = 0;\n` +
    `  try {\n` +
    `    const raw = fs.readFileSync(retryPath, 'utf8');\n` +
    `    retryAtMs = Number(JSON.parse(raw).retryAtMs || 0);\n` +
    `  } catch (_) {}\n` +
    `  if (!retryAtMs || Date.now() + 1000 < retryAtMs) process.exit(0);\n` +
    `  const argv = ['sync', '--auto', '--from-retry'];\n` +
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
    bucketMap.set(`${source}|${model}|${hourStart}`, bucket);
    linesRead += 1;
    if (linesRead >= maxBuckets) break;
  }

  rl.close();
  stream.close?.();
  return { buckets: Array.from(bucketMap.values()), nextOffset: offset };
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
      st.note = "reset_after_claude_repair_2026_05_v4";
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

async function reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath }) {
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
    ? await relabelClaudeMemQueueRows(queuePath)
    : 0;

  migrations[CLAUDE_MEM_OBSERVER_REINCLUDE_KEY] = {
    appliedAt: new Date().toISOString(),
    filesReset,
    hashesRemoved,
    queueRowsRelabeled,
  };
  return filesReset > 0 || hashesRemoved > 0 || queueRowsRelabeled > 0;
}

async function relabelClaudeMemQueueRows(queuePath) {
  let raw;
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (_e) {
    return 0;
  }
  if (!raw || !raw.includes('"claude-mem"')) return 0;

  const lines = raw.split("\n");
  const out = [];
  let relabeled = 0;
  for (const line of lines) {
    if (!line) {
      out.push(line);
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      out.push(line);
      continue;
    }
    if (obj && obj.source === "claude-mem") {
      obj.source = "claude";
      relabeled += 1;
      out.push(JSON.stringify(obj));
    } else {
      out.push(line);
    }
  }
  if (relabeled === 0) return 0;

  await fs.writeFile(queuePath, out.join("\n"), "utf8");
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
