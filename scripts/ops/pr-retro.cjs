#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FRONT_PREFIXES = ["dashboard/"];
const FRONT_FILES = [];
const BACK_PREFIXES = ["src/", "test/"];

function parseArgs(argv) {
  const out = {
    since: null,
    minCycles: 3,
    limit: 5,
    outDir: "docs/retrospective",
    fetchLimit: 200,
    includeUnmergedFallback: true,
    maxPrs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") out.since = argv[++i];
    else if (arg === "--min-cycles") out.minCycles = Number(argv[++i]);
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--out-dir") out.outDir = argv[++i];
    else if (arg === "--fetch-limit") out.fetchLimit = Number(argv[++i]);
    else if (arg === "--max-prs") out.maxPrs = Number(argv[++i]);
    else if (arg === "--no-unmerged-fallback") out.includeUnmergedFallback = false;
  }
  if (!Number.isFinite(out.minCycles) || out.minCycles <= 0) out.minCycles = 3;
  if (!Number.isFinite(out.limit) || out.limit <= 0) out.limit = 5;
  if (!Number.isFinite(out.fetchLimit) || out.fetchLimit <= 0) out.fetchLimit = 200;
  if (!Number.isFinite(out.maxPrs) || out.maxPrs <= 0) out.maxPrs = null;
  return out;
}

function runGh(args) {
  const output = execFileSync("gh", args, { encoding: "utf8" });
  return output.trim();
}

function jsonGh(args) {
  const raw = runGh(args);
  return raw ? JSON.parse(raw) : null;
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addMonths(date, delta) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCMonth(next.getUTCMonth() + delta);
  return next;
}

function isFrontPath(filePath) {
  if (FRONT_FILES.includes(filePath)) return true;
  return FRONT_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isBackPath(filePath) {
  return BACK_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isCodePath(filePath) {
  return isFrontPath(filePath) || isBackPath(filePath);
}

function summarizeText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function countItems(items) {
  return Array.isArray(items) ? items.length : 0;
}

function summarizePr(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    author: pr.author,
    labels: pr.labels || [],
    frontend: pr.frontend,
    backend: pr.backend,
    cycles: pr.cycles,
    reviewCount: countItems(pr.reviews),
    commentCount: countItems(pr.comments),
    commitCount: countItems(pr.commits),
    fileCount: countItems(pr.files),
  };
}

function shapeRetroOutput(prs, pickedNumbers) {
  const picked = pickedNumbers
    .map((number) => prs.find((pr) => pr.number === number))
    .filter(Boolean);
  const summaries = prs.map((pr) => summarizePr(pr));
  return { prs: summaries, picked };
}

function computeCycles(reviews, codeCommits) {
  const events = [];
  for (const review of reviews) {
    if (!review.submittedAt) continue;
    events.push({ type: "review", date: review.submittedAt });
  }
  for (const commit of codeCommits) {
    if (!commit.committedDate) continue;
    events.push({ type: "code", date: commit.committedDate });
  }
  events.sort((a, b) => {
    const delta = new Date(a.date) - new Date(b.date);
    if (delta !== 0) return delta;
    if (a.type === b.type) return 0;
    return a.type === "code" ? -1 : 1;
  });
  let sawReview = false;
  let sawCode = false;
  let cycles = 0;
  for (const event of events) {
    if (event.type === "review") {
      if (sawReview && sawCode) {
        cycles += 1;
        sawCode = false;
        sawReview = true;
      } else {
        sawReview = true;
      }
    } else if (event.type === "code") {
      if (sawReview) sawCode = true;
    }
  }
  return cycles;
}

function buildCsv(rows) {
  const header = [
    "number",
    "title",
    "url",
    "closed_at",
    "merged_at",
    "review_cycles",
    "frontend",
    "backend",
    "primary_stage",
    "secondary_stages",
    "topic_summary",
    "review_signals",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const fields = [
      row.number,
      JSON.stringify(row.title || ""),
      JSON.stringify(row.url || ""),
      row.closedAt || "",
      row.mergedAt || "",
      row.cycles ?? "",
      row.frontend ? "yes" : "no",
      row.backend ? "yes" : "no",
      "",
      "",
      "",
      "",
    ];
    lines.push(fields.join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoInfo = jsonGh(["repo", "view", "--json", "nameWithOwner"]);
  if (!repoInfo || !repoInfo.nameWithOwner) {
    throw new Error("Unable to resolve repo via gh.");
  }
  const [owner, repo] = repoInfo.nameWithOwner.split("/");
  const now = new Date();
  const since = args.since || formatDate(addMonths(now, -6));

  const prList =
    jsonGh([
      "pr",
      "list",
      "--state",
      "closed",
      "--search",
      `closed:>=${since}`,
      "--json",
      "number,title,closedAt,mergedAt,url,author,labels",
      "--limit",
      String(args.fetchLimit),
    ]) || [];

  const commitCache = new Map();

  function fetchCommitFiles(oid) {
    if (commitCache.has(oid)) return commitCache.get(oid);
    const detail = jsonGh(["api", `repos/${owner}/${repo}/commits/${oid}`]) || {};
    const files = Array.isArray(detail.files) ? detail.files : [];
    const paths = files.map((file) => file.filename).filter(Boolean);
    commitCache.set(oid, paths);
    return paths;
  }

  const prs = [];
  const cap = args.maxPrs ? prList.slice(0, args.maxPrs) : prList;
  let index = 0;
  for (const pr of cap) {
    index += 1;
    console.log(`Processing PR #${pr.number} (${index}/${cap.length})...`);
    const details = jsonGh([
      "pr",
      "view",
      String(pr.number),
      "--json",
      "number,title,closedAt,mergedAt,url,author,labels,reviews,comments,commits,files",
    ]);
    if (!details) continue;

    const reviews = Array.isArray(details.reviews) ? details.reviews : [];
    const filteredReviews = reviews
      .filter((review) => ["CHANGES_REQUESTED", "COMMENTED", "APPROVED"].includes(review.state))
      .map((review) => ({
        author: review.author?.login || null,
        state: review.state,
        submittedAt: review.submittedAt,
        body: summarizeText(review.body),
      }));

    const commits = Array.isArray(details.commits) ? details.commits : [];
    const files = Array.isArray(details.files) ? details.files : [];
    const filePaths = files.map((file) => file.path).filter(Boolean);
    const frontend = filePaths.some(isFrontPath);
    const backend = filePaths.some(isBackPath);

    let codeCommits = [];
    if (filteredReviews.length >= Math.max(args.minCycles + 1, 2) && filePaths.some(isCodePath)) {
      for (const commit of commits) {
        const oid = commit.oid;
        if (!oid) continue;
        const paths = fetchCommitFiles(oid);
        const hasCode = paths.some(isCodePath);
        if (hasCode) {
          codeCommits.push({
            oid,
            committedDate: commit.committedDate,
            files: paths,
          });
        }
      }
    }

    const cycles = computeCycles(filteredReviews, codeCommits);

    const comments = Array.isArray(details.comments) ? details.comments : [];
    const issueComments = comments.map((comment) => ({
      author: comment.author?.login || null,
      createdAt: comment.createdAt,
      body: summarizeText(comment.body),
    }));

    prs.push({
      number: details.number,
      title: details.title,
      url: details.url,
      closedAt: details.closedAt,
      mergedAt: details.mergedAt,
      author: details.author?.login || null,
      labels: (details.labels || []).map((label) => label.name),
      frontend,
      backend,
      cycles,
      reviews: filteredReviews,
      comments: issueComments,
      commits: codeCommits,
      files: filePaths,
    });
  }

  const minCycles = args.minCycles;
  const eligibleMerged = prs.filter((row) => row.mergedAt && row.cycles >= minCycles);
  let selected = eligibleMerged.slice();
  let usedClosedUnmerged = false;
  if (selected.length < args.limit && args.includeUnmergedFallback) {
    selected = prs.filter((row) => row.cycles >= minCycles);
    usedClosedUnmerged = true;
  }

  selected.sort((a, b) => {
    if (b.cycles !== a.cycles) return b.cycles - a.cycles;
    return new Date(b.closedAt) - new Date(a.closedAt);
  });

  const picked = selected.slice(0, args.limit);
  const pickedNumbers = picked.map((row) => row.number);
  const shaped = shapeRetroOutput(prs, pickedNumbers);

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = formatDate(now);
  const jsonPath = path.join(outDir, `${stamp}-pr-retro.json`);
  const csvPath = path.join(outDir, `${stamp}-pr-retro.csv`);

  const payload = {
    generatedAt: now.toISOString(),
    repo: repoInfo.nameWithOwner,
    since,
    minCycles,
    limit: args.limit,
    usedClosedUnmerged,
    totalClosed: prList.length,
    eligibleMerged: eligibleMerged.length,
    selectedCount: picked.length,
    selected: picked.map((row) => row.number),
    prs: shaped.prs,
    picked: shaped.picked,
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(csvPath, buildCsv(picked));

  const missing = args.limit - picked.length;
  if (missing > 0) {
    console.log(`Only found ${picked.length} PRs with review cycles >= ${minCycles}.`);
  }
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

module.exports = {
  main,
  summarizePr,
  shapeRetroOutput,
};
