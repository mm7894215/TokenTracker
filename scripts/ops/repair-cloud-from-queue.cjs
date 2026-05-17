#!/usr/bin/env node
/*
 * Repair cloud leaderboard by replaying the "latest value per bucket"
 * from the local queue.jsonl to the cloud ingest endpoint, then refresh
 * the leaderboard snapshot.
 *
 * Usage:
 *   node scripts/ops/repair-cloud-from-queue.cjs           # dry-run preview
 *   node scripts/ops/repair-cloud-from-queue.cjs --apply   # send to cloud
 *
 * Why this is safe: cloud ingest is an upsert keyed by
 * (user_id, device_id, source, model, hour_start). Re-sending the final
 * per-bucket value is idempotent and brings cloud into parity with the
 * local dashboard (which already deduplicates by last-write-wins).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TRACKER_DIR = path.join(os.homedir(), ".tokentracker", "tracker");
const QUEUE_PATH = path.join(TRACKER_DIR, "queue.jsonl");
const CONFIG_PATH = path.join(TRACKER_DIR, "config.json");

const BATCH_SIZE = 200;
const INGEST_SLUG = "tokentracker-ingest";
const REFRESH_SLUG = "tokentracker-leaderboard-refresh";
const LEADERBOARD_SLUG = "tokentracker-leaderboard";

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.baseUrl || !cfg.deviceToken) {
    throw new Error("baseUrl or deviceToken missing from config.json");
  }
  return { baseUrl: cfg.baseUrl.replace(/\/$/, ""), deviceToken: cfg.deviceToken };
}

function compactQueue() {
  const raw = fs.readFileSync(QUEUE_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const seen = new Map();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (!row.hour_start) continue;
    const source = (row.source || "codex").trim().toLowerCase() || "codex";
    const model = (row.model || "unknown").trim() || "unknown";
    row.source = source;
    row.model = model;
    seen.set(`${source}|${model}|${row.hour_start}`, row);
  }
  return Array.from(seen.values());
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  try { return JSON.parse(text); } catch { return {}; }
}

async function getJson(url) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function summarize(rows) {
  const bySource = new Map();
  for (const r of rows) {
    const s = r.source;
    if (!bySource.has(s)) bySource.set(s, { buckets: 0, total: 0 });
    const a = bySource.get(s);
    a.buckets += 1;
    a.total += Number(r.total_tokens || 0);
  }
  return bySource;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { baseUrl, deviceToken } = readConfig();

  const rows = compactQueue();
  const summary = summarize(rows);
  const grand = Array.from(summary.values()).reduce((a, b) => a + b.total, 0);

  console.log(`Queue compaction: ${rows.length} unique (source, model, hour_start) buckets`);
  console.log(`${"source".padEnd(12)} ${"buckets".padStart(8)} ${"last_total".padStart(18)}`);
  for (const [s, a] of [...summary.entries()].sort((x, y) => y[1].total - x[1].total)) {
    console.log(`${s.padEnd(12)} ${String(a.buckets).padStart(8)} ${fmt(a.total).padStart(18)}`);
  }
  console.log(`${"TOTAL".padEnd(12)} ${String(rows.length).padStart(8)} ${fmt(grand).padStart(18)}`);

  try {
    const lbBefore = await getJson(`${baseUrl}/functions/${LEADERBOARD_SLUG}?period=total&limit=1`);
    const me = lbBefore?.entries?.[0];
    if (me) {
      console.log(
        `\nCloud leaderboard (before): total=${fmt(me.total_tokens)} cursor=${fmt(me.cursor_tokens)} kiro=${fmt(me.kiro_tokens)} generated_at=${me.generated_at}`,
      );
    }
  } catch (e) {
    console.log("(could not read leaderboard snapshot before: " + e.message + ")");
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to send to cloud.");
    return;
  }

  console.log(`\nSending ${rows.length} buckets in batches of ${BATCH_SIZE}...`);
  let inserted = 0;
  let skipped = 0;
  let batches = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((r) => ({
      hour_start: r.hour_start,
      source: r.source,
      model: r.model,
      input_tokens: Number(r.input_tokens || 0),
      cached_input_tokens: Number(r.cached_input_tokens || 0),
      cache_creation_input_tokens: Number(r.cache_creation_input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      reasoning_output_tokens: Number(r.reasoning_output_tokens || 0),
      total_tokens: Number(r.total_tokens || 0),
      conversation_count: Number(r.conversation_count || 0),
    }));
    const res = await postJson(`${baseUrl}/functions/${INGEST_SLUG}`, deviceToken, { hourly: batch });
    inserted += Number(res?.inserted || 0);
    skipped += Number(res?.skipped || 0);
    batches += 1;
    if (batches % 5 === 0 || i + BATCH_SIZE >= rows.length) {
      process.stdout.write(`  batch ${batches} done (inserted=${inserted} skipped=${skipped})\n`);
    }
  }
  console.log(`\nIngest done: inserted=${inserted} skipped=${skipped} across ${batches} batches`);

  console.log("\nTriggering leaderboard refresh (period=total)...");
  try {
    const ref = await postJson(
      `${baseUrl}/functions/${REFRESH_SLUG}?period=total`,
      deviceToken,
      {},
    );
    console.log("Refresh response:", JSON.stringify(ref).slice(0, 400));
  } catch (e) {
    console.log("Refresh failed (service-role only?):", e.message);
    console.log("Leaderboard will still self-refresh on its next scheduled tick.");
  }

  try {
    const lbAfter = await getJson(`${baseUrl}/functions/${LEADERBOARD_SLUG}?period=total&limit=1`);
    const me = lbAfter?.entries?.[0];
    if (me) {
      console.log(
        `\nCloud leaderboard (after): total=${fmt(me.total_tokens)} cursor=${fmt(me.cursor_tokens)} kiro=${fmt(me.kiro_tokens)} generated_at=${me.generated_at}`,
      );
    }
  } catch (e) {
    console.log("(could not read leaderboard snapshot after: " + e.message + ")");
  }
}

main().catch((e) => {
  console.error("repair failed:", e);
  process.exit(1);
});
