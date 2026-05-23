"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { aggregateWrapped, formatCompact } = require("../lib/wrapped-aggregator");

async function readQueueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  const raw = await fs.promises.readFile(queuePath, "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_e) {
      // skip malformed line — production queues sometimes hold a partial
      // tail row mid-write that becomes valid on the next read.
    }
  }
  return rows;
}

function parseArgs(argv) {
  const out = { year: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--year") {
      const v = argv[++i];
      const y = Number(v);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        throw new Error(`--year expects a 4-digit year, got: ${v}`);
      }
      out.year = y;
    } else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

function renderAscii(wrapped) {
  const lines = [];
  const w = 60;
  const border = "═".repeat(w - 2);
  const center = (s) => {
    const text = String(s);
    const padTotal = Math.max(0, w - 2 - text.length);
    const left = Math.floor(padTotal / 2);
    const right = padTotal - left;
    return `║${" ".repeat(left)}${text}${" ".repeat(right)}║`;
  };
  const row = (label, value) => {
    const text = `  ${label}: ${value}`;
    const right = Math.max(0, w - 2 - text.length);
    return `║${text}${" ".repeat(right)}║`;
  };

  lines.push(`╔${border}╗`);
  lines.push(center(""));
  lines.push(center(`TokenTracker Wrapped · ${wrapped.year}`));
  lines.push(center(""));
  lines.push(`╠${border}╣`);
  lines.push(row("Total tokens", formatCompact(wrapped.totals.tokens)));
  lines.push(row("Conversations", wrapped.totals.conversations.toLocaleString("en-US")));
  lines.push(row("Active days", `${wrapped.totals.active_days} / 365`));
  lines.push(row("Tools used", String(wrapped.totals.sources)));
  lines.push(row("Models used", String(wrapped.totals.models)));
  if (wrapped.peak_hour) {
    lines.push(
      row(
        "Peak hour",
        `${String(wrapped.peak_hour.hour).padStart(2, "0")}:00 UTC (${formatCompact(wrapped.peak_hour.tokens)})`,
      ),
    );
  }
  if (wrapped.longest_streak.days > 0) {
    lines.push(
      row("Longest streak", `${wrapped.longest_streak.days} days (${wrapped.longest_streak.from} → ${wrapped.longest_streak.to})`),
    );
  }
  lines.push(`╠${border}╣`);

  if (wrapped.top.sources.length > 0) {
    lines.push(row("Top tools", ""));
    for (const s of wrapped.top.sources.slice(0, 3)) {
      lines.push(row(`  ${s.source}`, `${formatCompact(s.tokens)} (${(s.share * 100).toFixed(0)}%)`));
    }
  }
  if (wrapped.top.models.length > 0) {
    lines.push(`╠${border}╣`);
    lines.push(row("Top models", ""));
    for (const m of wrapped.top.models.slice(0, 3)) {
      lines.push(row(`  ${m.model}`, `${formatCompact(m.tokens)} (${(m.share * 100).toFixed(0)}%)`));
    }
  }
  if (wrapped.top.days.length > 0) {
    lines.push(`╠${border}╣`);
    lines.push(row("Top days", ""));
    for (const d of wrapped.top.days.slice(0, 3)) {
      lines.push(row(`  ${d.day}`, formatCompact(d.tokens)));
    }
  }
  if (wrapped.highlights.length > 0) {
    lines.push(`╠${border}╣`);
    const max = w - 4; // 2 borders + 2 padding
    for (const h of wrapped.highlights) {
      // Wrap long highlights into multiple rows.
      for (let start = 0; start < h.length; start += max) {
        const segment = h.slice(start, start + max);
        const padded = ` ${segment}`;
        const right = Math.max(0, w - 2 - padded.length);
        lines.push(`║${padded}${" ".repeat(right)}║`);
      }
    }
  }
  lines.push(`╚${border}╝`);
  return lines.join("\n");
}

async function cmdWrapped(argv = []) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir } = await resolveTrackerPaths({ home });
  const queuePath = path.join(trackerDir, "queue.jsonl");

  const rows = await readQueueRows(queuePath);
  if (rows.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: "no data" }, null, 2) + "\n");
    } else {
      process.stdout.write(
        "No queue data found yet. Run `tracker sync` first to ingest some history.\n",
      );
    }
    return;
  }

  const wrapped = aggregateWrapped(rows, opts.year ? { year: opts.year } : {});

  if (opts.json) {
    process.stdout.write(JSON.stringify(wrapped, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderAscii(wrapped) + "\n");
}

module.exports = { cmdWrapped };
