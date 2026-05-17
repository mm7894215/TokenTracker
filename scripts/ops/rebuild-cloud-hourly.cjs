#!/usr/bin/env node
/*
 * Rebuild the cloud tokentracker_hourly table for a single user so it
 * exactly matches the local queue.jsonl last-value-per-bucket snapshot.
 *
 * Procedure:
 *   1. DELETE all rows for USER_ID
 *   2. INSERT compacted rows bound to DEVICE_ID (200 per statement)
 *   3. Trigger leaderboard-refresh
 *
 * Runs `npx @insforge/cli db query` for each SQL statement.
 *
 * Safety: backup first with
 *   npx @insforge/cli db query "SELECT ... WHERE user_id=..." --json > backup.json
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const USER_ID = "0652839f-d19f-4f67-af85-6b7675875443";
const DEVICE_ID = "d7ce6c65-3075-4461-92ae-59f4cad6f7a8";
const BATCH = 50;
const MAX_RETRIES = 3;
const QUEUE_PATH = path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");

function esc(s) {
  return String(s).replace(/'/g, "''");
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function runSql(sql) {
  return execFileSync("npx", ["--yes", "@insforge/cli", "db", "query", sql, "--json"], {
    cwd: "/Users/sunxiufeng/tokentracker",
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}
function compactQueue() {
  const raw = fs.readFileSync(QUEUE_PATH, "utf8");
  const seen = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.hour_start) continue;
    const source = (r.source || "codex").trim().toLowerCase() || "codex";
    const model = (r.model || "unknown").trim() || "unknown";
    r.source = source;
    r.model = model;
    seen.set(`${source}|${model}|${r.hour_start}`, r);
  }
  return Array.from(seen.values());
}

function main() {
  const apply = process.argv.includes("--apply");
  const rows = compactQueue();
  const grand = rows.reduce((a, r) => a + num(r.total_tokens), 0);

  console.log(`Queue compaction: ${rows.length} unique buckets, total=${grand.toLocaleString()}`);
  if (!apply) {
    console.log("Dry-run. Re-run with --apply to DELETE then INSERT.");
    return;
  }

  const skipDelete = process.argv.includes("--no-delete");
  if (!skipDelete) {
    console.log(`\n[1/3] DELETE all rows for user ${USER_ID}...`);
    const delOut = runSql(`DELETE FROM tokentracker_hourly WHERE user_id = '${USER_ID}'`);
    console.log("  " + (JSON.parse(delOut).rowCount ?? "?") + " rows deleted");
  } else {
    console.log("\n[1/3] SKIP delete (resume mode)");
  }

  const startArg = process.argv.find((a) => a.startsWith("--start="));
  const startIdx = startArg ? Number(startArg.slice(8)) || 0 : 0;

  console.log(`\n[2/3] INSERT ${rows.length - startIdx} rows in batches of ${BATCH} (start=${startIdx})...`);
  let inserted = 0;
  for (let i = startIdx; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map((r) => {
      const totalTokens = num(r.total_tokens);
      return (
        `('${USER_ID}','${DEVICE_ID}','${esc(r.source)}','${esc(r.model)}','${esc(r.hour_start)}',` +
        `${num(r.input_tokens)},${num(r.cached_input_tokens)},${num(r.cache_creation_input_tokens)},` +
        `${num(r.output_tokens)},${num(r.reasoning_output_tokens)},${totalTokens},${totalTokens},` +
        `${num(r.conversation_count)},NOW(),NOW(),0)`
      );
    }).join(",");
    const sql =
      `INSERT INTO tokentracker_hourly ` +
      `(user_id, device_id, source, model, hour_start, ` +
      `input_tokens, cached_input_tokens, cache_creation_input_tokens, ` +
      `output_tokens, reasoning_output_tokens, total_tokens, billable_total_tokens, ` +
      `conversations, created_at, updated_at, total_cost_usd) VALUES ${values} ` +
      `ON CONFLICT (user_id, device_id, source, model, hour_start) DO UPDATE SET ` +
      `input_tokens = EXCLUDED.input_tokens, ` +
      `cached_input_tokens = EXCLUDED.cached_input_tokens, ` +
      `cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens, ` +
      `output_tokens = EXCLUDED.output_tokens, ` +
      `reasoning_output_tokens = EXCLUDED.reasoning_output_tokens, ` +
      `total_tokens = EXCLUDED.total_tokens, ` +
      `billable_total_tokens = EXCLUDED.billable_total_tokens, ` +
      `conversations = EXCLUDED.conversations, ` +
      `updated_at = NOW()`;

    let tries = 0;
    while (true) {
      try { runSql(sql); break; }
      catch (e) {
        tries += 1;
        if (tries >= MAX_RETRIES) {
          console.error(`  batch starting at index ${i} failed after ${MAX_RETRIES} retries. Resume with --no-delete --start=${i}`);
          throw e;
        }
        console.log(`  retry ${tries}/${MAX_RETRIES} for batch@${i}`);
      }
    }
    inserted += batch.length;
    if (((i / BATCH) | 0) % 10 === 0 || i + BATCH >= rows.length) {
      console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${i + batch.length}/${rows.length}`);
    }
  }
  console.log(`  ${inserted} rows inserted`);

  console.log("\n[3/3] Refresh leaderboard (period=total) via HTTP endpoint...");
  // Skip HTTP refresh here; user can trigger manually or via script afterwards.
  console.log("  skip — run scripts/ops/repair-cloud-from-queue.cjs style refresh separately.");
}

main();
