const fs = require("node:fs/promises");

async function summarizeQueueData(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const rowsByBucket = new Map();
  let malformedLines = 0;
  let lineCount = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lineCount += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_error) {
      malformedLines += 1;
      continue;
    }
    const hourStart = typeof row?.hour_start === "string" ? row.hour_start : "";
    if (!hourStart) continue;
    const source = typeof row?.source === "string" && row.source.trim() ? row.source.trim() : "codex";
    const model = typeof row?.model === "string" && row.model.trim() ? row.model.trim() : "unknown";
    rowsByBucket.set(`${source}|${model}|${hourStart}`, row);
  }

  let totalTokens = 0;
  let billableTotalTokens = 0;
  const sources = new Set();
  for (const row of rowsByBucket.values()) {
    totalTokens += Number(row?.total_tokens || 0);
    billableTotalTokens += Number(row?.billable_total_tokens ?? row?.total_tokens ?? 0);
    if (typeof row?.source === "string" && row.source.trim()) {
      sources.add(row.source.trim());
    }
  }

  return {
    queuePath,
    lineCount,
    malformedLines,
    bucketCount: rowsByBucket.size,
    totalTokens,
    billableTotalTokens,
    sources: Array.from(sources).sort(),
  };
}

function buildServeDataPreflightMessage({ queueSummary, syncSummary } = {}) {
  const totalTokens = Number(queueSummary?.totalTokens || 0);
  const parsedFiles = Number(syncSummary?.totalParsed || 0);
  const queuedBuckets = Number(syncSummary?.totalBuckets || 0);

  if (totalTokens > 0) {
    const sources = Array.isArray(queueSummary?.sources) ? queueSummary.sources : [];
    return {
      status: "ok",
      message: `Token data preflight: ${queueSummary.bucketCount} buckets, ${totalTokens.toLocaleString()} tokens${sources.length ? ` (${sources.join(", ")})` : ""}.`,
    };
  }

  if (parsedFiles > 0 || queuedBuckets > 0 || Number(queueSummary?.lineCount || 0) > 0) {
    return {
      status: "warn",
      message: [
        "Token data preflight warning: local data was parsed, but the dashboard queue still has 0 tokens.",
        `Parsed files: ${parsedFiles}; new buckets: ${queuedBuckets}; queue rows: ${queueSummary?.lineCount || 0}.`,
        "Run `tokentracker status --light` or `tokentracker doctor` on this machine to check readable tool logs and hook state.",
      ].join("\n"),
    };
  }

  return {
    status: "warn",
    message: [
      "Token data preflight warning: no local token data was found after sync.",
      "The dashboard can open, but Total tokens will stay empty until this machine has readable AI tool session logs.",
      "Run `tokentracker status --light` or `tokentracker doctor` on this machine to see which providers are configured or skipped.",
    ].join("\n"),
  };
}

module.exports = {
  summarizeQueueData,
  buildServeDataPreflightMessage,
};
