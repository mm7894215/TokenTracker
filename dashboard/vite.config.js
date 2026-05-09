import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import os from "node:os";

const COPY_REQUIRED_KEYS = [
  "landing.meta.title",
  "landing.meta.description",
  "landing.meta.og_site_name",
  "landing.meta.og_type",
  "landing.meta.og_image",
  "landing.meta.og_url",
  "landing.meta.twitter_card",
  "share.meta.title",
  "share.meta.description",
  "share.meta.og_site_name",
  "share.meta.og_type",
  "share.meta.og_image",
  "share.meta.og_url",
  "share.meta.twitter_card",
];

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COPY_PATH = path.join(ROOT_DIR, "src", "content", "copy.csv");
const PACKAGE_JSON_PATH = path.resolve(ROOT_DIR, "..", "package.json");
const REPO_ROOT = path.resolve(ROOT_DIR, "..");
const LOCAL_SYNC_TIMEOUT_MS = 120_000;

function loadAppVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.version || "").trim() || null;
  } catch (error) {
    console.warn("[tokentracker] Failed to read package.json version:", error.message);
    return null;
  }
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = raw[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => cell.trim() === "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (!row.every((cell) => cell.trim() === "")) {
    rows.push(row);
  }

  return rows;
}

function loadCopyRegistry() {
  let raw = "";
  try {
    raw = fs.readFileSync(COPY_PATH, "utf8");
  } catch (error) {
    console.warn("[tokentracker] Failed to read copy registry:", error.message);
    return new Map();
  }

  const rows = parseCsv(raw);
  if (!rows.length) return new Map();

  const header = rows[0].map((cell) => cell.trim());
  const keyIndex = header.indexOf("key");
  const textIndex = header.indexOf("text");
  if (keyIndex === -1 || textIndex === -1) {
    console.warn("[tokentracker] Copy registry missing key/text columns.");
    return new Map();
  }

  const map = new Map();
  rows.slice(1).forEach((cells) => {
    const key = String(cells[keyIndex] || "").trim();
    if (!key) return;
    const text = String(cells[textIndex] ?? "").trim();
    map.set(key, text);
  });

  return map;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMeta(prefix = "landing") {
  const map = loadCopyRegistry();
  const read = (key) => map.get(`${prefix}.meta.${key}`) || "";

  const missing = COPY_REQUIRED_KEYS.filter((key) => !map.has(key));
  if (missing.length) {
    console.warn("[tokentracker] Copy registry missing keys:", missing.join(", "));
  }

  return {
    title: read("title"),
    description: read("description"),
    ogSiteName: read("og_site_name"),
    ogType: read("og_type"),
    ogImage: read("og_image"),
    ogUrl: read("og_url"),
    twitterCard: read("twitter_card"),
  };
}

function resolveMetaPrefix(ctx) {
  const rawPath = String(ctx?.path || ctx?.filename || ctx?.originalUrl || "").toLowerCase();
  if (rawPath.includes("share")) return "share";
  if (rawPath.includes("wrapped-2025")) return "share";
  return "landing";
}

function injectRichMeta(html, prefix) {
  const meta = buildMeta(prefix);
  const replacements = {
    __TOKENTRACKER_TITLE__: meta.title,
    __TOKENTRACKER_DESCRIPTION__: meta.description,
    __TOKENTRACKER_OG_SITE_NAME__: meta.ogSiteName,
    __TOKENTRACKER_OG_TITLE__: meta.title,
    __TOKENTRACKER_OG_DESCRIPTION__: meta.description,
    __TOKENTRACKER_OG_IMAGE__: meta.ogImage,
    __TOKENTRACKER_OG_TYPE__: meta.ogType,
    __TOKENTRACKER_OG_URL__: meta.ogUrl,
    __TOKENTRACKER_TWITTER_CARD__: meta.twitterCard,
    __TOKENTRACKER_TWITTER_TITLE__: meta.title,
    __TOKENTRACKER_TWITTER_DESCRIPTION__: meta.description,
    __TOKENTRACKER_TWITTER_IMAGE__: meta.ogImage,
  };

  let output = html;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.replaceAll(token, escapeHtml(value));
  }
  return output;
}

function richLinkMetaPlugin() {
  return {
    name: "tokentracker-rich-link-meta",
    transformIndexHtml(html, ctx) {
      return injectRichMeta(html, resolveMetaPrefix(ctx));
    },
  };
}

// 本地数据 API 插件 - 直接读取 ~/.tokentracker/tracker/queue.jsonl
// 本地 API 处理函数
function trimCommandOutput(value, maxLength = 4000) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function readJsonBodyVite(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function runLocalSyncCommand(extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tokentracker-cli", "sync"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      handler(value);
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, Object.assign(new Error("Local sync timed out after 120 seconds"), {
        code: "SYNC_TIMEOUT",
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      }));
    }, LOCAL_SYNC_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(reject, Object.assign(error, {
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      }));
    });

    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      };

      if (code === 0) {
        finish(resolve, result);
        return;
      }

      finish(reject, Object.assign(new Error(result.stderr || result.stdout || `Local sync exited with code ${result.code}`), result));
    });
  });
}

// Per-model pricing — delegated to src/lib/pricing/ (CJS). vite.config.js is
// ESM but createRequire (already imported above) gives us first-class CJS
// interop. The pricing module loads its bundled seed snapshot synchronously
// at require-time, so dev-server mocks still get LiteLLM-backed cost data.
const __viteRequire = createRequire(import.meta.url);
const __pricing = __viteRequire(path.resolve(REPO_ROOT, "src/lib/pricing"));
const { getModelPricing, computeRowCost } = __pricing;

async function handleLocalApi(req, res, url) {
  const QUEUE_PATH = path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");

  function isLegacyInclusiveCodexRow(row) {
    if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
    const inputTokens = Number(row.input_tokens || 0);
    const cachedInputTokens = Number(row.cached_input_tokens || 0);
    const outputTokens = Number(row.output_tokens || 0);
    const totalTokens = Number(row.total_tokens || 0);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
    if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
    return totalTokens === inputTokens + outputTokens;
  }

  function normalizeQueueRow(row) {
    if (!isLegacyInclusiveCodexRow(row)) return row;
    return {
      ...row,
      input_tokens: Number(row.input_tokens || 0) - Number(row.cached_input_tokens || 0),
    };
  }

  function readQueueData() {
    try {
      const raw = fs.readFileSync(QUEUE_PATH, "utf8");
      const lines = raw.split("\n").filter(line => line.trim());
      const parsed = lines.map(line => JSON.parse(line));
      // Deduplicate: each sync appends cumulative totals per bucket, so for
      // each (source, model, hour_start) keep only the latest (last) entry.
      const seen = new Map();
      for (const row of parsed) {
        const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
        seen.set(key, normalizeQueueRow(row));
      }
      return Array.from(seen.values());
    } catch (error) {
      console.warn("[localDataApi] Failed to read queue.jsonl:", error.message);
      return [];
    }
  }

  function aggregateByDay(rows) {
    const byDay = new Map();
    for (const row of rows) {
      const hourStart = row.hour_start;
      if (!hourStart) continue;
      const day = hourStart.slice(0, 10);
      if (!byDay.has(day)) {
        byDay.set(day, {
          day,
          total_tokens: 0,
          billable_total_tokens: 0,
          total_cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: 0,
          conversation_count: 0,
        });
      }
      const agg = byDay.get(day);
      agg.total_tokens += row.total_tokens || 0;
      agg.billable_total_tokens += row.total_tokens || 0;
      agg.total_cost_usd += computeRowCost(row);
      agg.input_tokens += row.input_tokens || 0;
      agg.output_tokens += row.output_tokens || 0;
      agg.cached_input_tokens += row.cached_input_tokens || 0;
      agg.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      agg.reasoning_output_tokens += row.reasoning_output_tokens || 0;
      agg.conversation_count += row.conversation_count || 0;
    }
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  }

  const pathname = url.pathname;

  if (pathname === "/functions/tokentracker-local-sync") {
    if (String(req.method || "GET").toUpperCase() !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
      return true;
    }

    try {
      let body = {};
      try {
        body = await readJsonBodyVite(req);
      } catch {
        body = {};
      }
      const extraEnv = {};
      if (typeof body.deviceToken === "string" && body.deviceToken.trim()) {
        extraEnv.TOKENTRACKER_DEVICE_TOKEN = body.deviceToken.trim();
      }
      if (typeof body.insforgeBaseUrl === "string" && /^https?:\/\//i.test(body.insforgeBaseUrl.trim())) {
        extraEnv.TOKENTRACKER_INSFORGE_BASE_URL = body.insforgeBaseUrl.trim();
      }
      const result = await runLocalSyncCommand(extraEnv);
      try {
        const esmRequire = createRequire(import.meta.url);
        const { resetUsageLimitsCache } = esmRequire("../src/lib/usage-limits");
        resetUsageLimitsCache();
      } catch (_e) {
        // ignore
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: false,
        error: error?.message || "Local sync failed",
        code: error?.code ?? null,
        stdout: error?.stdout || "",
        stderr: error?.stderr || "",
      }));
    }
    return true;
  }

  // 处理 usage-summary
  if (pathname === "/functions/tokentracker-usage-summary") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();
    const daily = aggregateByDay(rows).filter(d => d.day >= from && d.day <= to);
    const totals = daily.reduce((acc, row) => {
      acc.total_tokens += row.total_tokens;
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.total_cost_usd += row.total_cost_usd || 0;
      acc.input_tokens += row.input_tokens;
      acc.output_tokens += row.output_tokens;
      acc.cached_input_tokens += row.cached_input_tokens;
      acc.cache_creation_input_tokens += row.cache_creation_input_tokens;
      acc.reasoning_output_tokens += row.reasoning_output_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, {
      total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0,
      output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0,
    });
    const totalCost = totals.total_cost_usd;

    // 计算 rolling 统计数据（最近7天和30天）
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const allDaily = aggregateByDay(rows);

    // 计算最近7天
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayData = allDaily.find(x => x.day === dayStr);
      if (dayData) last7Days.push(dayData);
    }
    const last7dTotals = last7Days.reduce((acc, row) => {
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, { billable_total_tokens: 0, conversation_count: 0 });

    // 计算最近30天
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayData = allDaily.find(x => x.day === dayStr);
      if (dayData) last30Days.push(dayData);
    }
    const last30dTotals = last30Days.reduce((acc, row) => {
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, { billable_total_tokens: 0, conversation_count: 0 });
    const avgPerActiveDay = last30Days.length > 0 ? Math.round(last30dTotals.billable_total_tokens / last30Days.length) : 0;

    // 计算 last_7d 和 last_30d 的日期范围
    const last7dFrom = new Date(today);
    last7dFrom.setUTCDate(last7dFrom.getUTCDate() - 6);
    const last30dFrom = new Date(today);
    last30dFrom.setUTCDate(last30dFrom.getUTCDate() - 29);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      from, to, days: daily.length,
      totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
      rolling: {
        last_7d: {
          from: last7dFrom.toISOString().slice(0, 10),
          to: todayStr,
          active_days: last7Days.length,
          totals: last7dTotals,
        },
        last_30d: {
          from: last30dFrom.toISOString().slice(0, 10),
          to: todayStr,
          active_days: last30Days.length,
          totals: last30dTotals,
          avg_per_active_day: avgPerActiveDay,
        },
      },
    }));
    return true;
  }

  // 处理 usage-daily
  if (pathname === "/functions/tokentracker-usage-daily") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();
    const daily = aggregateByDay(rows).filter(d => d.day >= from && d.day <= to);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ from, to, data: daily }));
    return true;
  }

  // 处理 usage-heatmap
  if (pathname === "/functions/tokentracker-usage-heatmap") {
    const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
    const rows = readQueueData();
    const daily = aggregateByDay(rows);
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const byDay = new Map(daily.map(d => [d.day, d]));
    const cells = [];
    const cursor = new Date(start);

    // 先收集所有有数据的天，计算 level 阈值
    const allValues = daily.map(d => d.billable_total_tokens).filter(v => v > 0).sort((a, b) => a - b);
    const maxValue = allValues.length > 0 ? allValues[allValues.length - 1] : 0;

    // 根据最大值计算 level (0-4)
    function calcLevel(value) {
      if (value <= 0) return 0;
      if (maxValue === 0) return 1;
      const ratio = value / maxValue;
      if (ratio <= 0.25) return 1;
      if (ratio <= 0.5) return 2;
      if (ratio <= 0.75) return 3;
      return 4;
    }

    while (cursor <= end) {
      const day = cursor.toISOString().slice(0, 10);
      const data = byDay.get(day);
      const billable = data?.billable_total_tokens || 0;
      cells.push({
        day,
        total_tokens: data?.total_tokens || 0,
        billable_total_tokens: billable,
        level: calcLevel(billable),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const activeDays = cells.filter(c => c.billable_total_tokens > 0).length;
    // 转为 weeks 二维数组（每 7 天一组），与 local-api.js 格式一致
    const weeksArr = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeksArr.push(cells.slice(i, i + 7));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ from, to, week_starts_on: "sun", active_days: activeDays, streak_days: 0, weeks: weeksArr }));
    return true;
  }

  // 处理 usage-model-breakdown
  if (pathname === "/functions/tokentracker-usage-model-breakdown") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();

    // 过滤日期范围
    const filteredRows = rows.filter(row => {
      if (!row.hour_start) return false;
      const day = row.hour_start.slice(0, 10);
      return day >= from && day <= to;
    });

    const bySource = new Map();

    // 先按 source 和 model 分组统计
    for (const row of filteredRows) {
      const source = row.source || "unknown";
      const modelName = row.model || "unknown";

      if (!bySource.has(source)) {
        bySource.set(source, {
          source,
          totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" },
          models: new Map()
        });
      }
      const sourceAgg = bySource.get(source);

      // 累加 source 总计
      sourceAgg.totals.total_tokens += row.total_tokens || 0;
      sourceAgg.totals.billable_total_tokens += row.total_tokens || 0;
      sourceAgg.totals.input_tokens += row.input_tokens || 0;
      sourceAgg.totals.output_tokens += row.output_tokens || 0;
      sourceAgg.totals.cached_input_tokens += row.cached_input_tokens || 0;
      sourceAgg.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      sourceAgg.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;

      // 按 model 分组
      if (!sourceAgg.models.has(modelName)) {
        sourceAgg.models.set(modelName, {
          model: modelName,
          model_id: modelName,
          totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }
        });
      }
      const modelAgg = sourceAgg.models.get(modelName);
      modelAgg.totals.total_tokens += row.total_tokens || 0;
      modelAgg.totals.billable_total_tokens += row.total_tokens || 0;
      modelAgg.totals.input_tokens += row.input_tokens || 0;
      modelAgg.totals.output_tokens += row.output_tokens || 0;
      modelAgg.totals.cached_input_tokens += row.cached_input_tokens || 0;
      modelAgg.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      modelAgg.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    }

    // 转换为最终格式
    const sources = Array.from(bySource.values()).map(s => {
      s.models = Array.from(s.models.values()).map(m => {
        const cost = computeRowCost({
          ...m.totals,
          model: m.model,
          source: s.source,
        });
        return { ...m, totals: { ...m.totals, total_cost_usd: cost.toFixed(6) } };
      }).sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
      const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
      s.totals.total_cost_usd = sourceCost.toFixed(6);
      return s;
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      from, to, days: 0, sources,
      pricing: { model: "default", pricing_mode: "add", source: "default", effective_from: new Date().toISOString().slice(0, 10), rates_per_million_usd: { input: "1.750000", cached_input: "0.175000", output: "14.000000", reasoning_output: "14.000000" } },
    }));
    return true;
  }

  // 处理 usage-category-breakdown — Claude Code only
  // Reuse the CLI's claude-categorizer module so dev server returns the
  // same shape as the production endpoint.
  if (pathname === "/functions/tokentracker-usage-category-breakdown") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const requestedSource = (url.searchParams.get("source") || "claude").trim().toLowerCase();
    try {
      const categorizerPath = path.join(ROOT_DIR, "..", "src", "lib", "claude-categorizer");
      // Bust the require cache so dev edits to the categorizer module
      // surface without restarting the vite server.
      const resolved = __viteRequire.resolve(categorizerPath);
      delete __viteRequire.cache[resolved];
      const { computeClaudeCategoryBreakdown, unsupportedSourcePayload } = __viteRequire(categorizerPath);
      if (requestedSource !== "claude") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ from, to, ...unsupportedSourcePayload(requestedSource) }));
        return true;
      }
      const result = await computeClaudeCategoryBreakdown({ from, to, projectDir: process.cwd() });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ from, to, ...result }));
    } catch (e) {
      console.warn("[vite-mock] usage-category-breakdown failed:", e?.message || e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e?.message || "compute_failed" }));
    }
    return true;
  }

  // 处理 project-usage-summary
  if (pathname === "/functions/tokentracker-project-usage-summary") {
    // 优先读 ~/.tokentracker/tracker/project.queue.jsonl（与 7680 真实归因一致）
    const projectQueuePath = path.join(os.homedir(), ".tokentracker", "tracker", "project.queue.jsonl");
    try {
      const projectRaw = fs.readFileSync(projectQueuePath, "utf8");
      const dedup = new Map();
      for (const line of projectRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          const k = `${row.project_key || ""}|${row.source || ""}|${row.hour_start || ""}`;
          dedup.set(k, row);
        } catch { /* skip malformed */ }
      }
      const byProject = new Map();
      for (const row of dedup.values()) {
        const key = row.project_key || "unknown";
        if (!byProject.has(key)) {
          byProject.set(key, {
            project_key: key,
            project_ref: row.project_ref || key,
            total_tokens: 0,
            billable_total_tokens: 0,
          });
        }
        const agg = byProject.get(key);
        agg.total_tokens += Number(row.total_tokens || 0);
        agg.billable_total_tokens += Number(row.total_tokens || 0);
        if (!agg.project_ref && row.project_ref) agg.project_ref = row.project_ref;
      }
      if (byProject.size > 0) {
        const entries = Array.from(byProject.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .map((e) => ({
            ...e,
            total_tokens: String(e.total_tokens),
            billable_total_tokens: String(e.billable_total_tokens),
          }));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ generated_at: new Date().toISOString(), entries }));
        return true;
      }
    } catch (e) {
      if (e?.code !== "ENOENT") console.warn("[vite-mock] project.queue.jsonl read failed:", e?.message || e);
    }

    // Fallback：扫 raw 日志按 session count 估算（旧逻辑）
    const projectMap = new Map();

    function parseGitUrl(url) {
      if (!url) return null;
      // 处理 SSH 格式: git@host:owner/repo.git
      const sshMatch = url.match(/git@[^:]+:([^\/]+)\/(.+?)(?:\.git)?$/);
      if (sshMatch) {
        return { host: 'gitlab', owner: sshMatch[1], repo: sshMatch[2] };
      }
      // 处理 HTTP 格式: http(s)://host/owner/repo.git
      const httpMatch = url.match(/https?:\/\/[^\/]+\/([^\/]+)\/(.+?)(?:\.git)?$/);
      if (httpMatch) {
        return { host: 'gitlab', owner: httpMatch[1], repo: httpMatch[2] };
      }
      return null;
    }

    // 从 cwd 提取项目名
    function extractProjectFromCwd(cwd) {
      if (!cwd || cwd === '/Users/sunxiufeng' || cwd === os.homedir()) return null;
      // 移除 home 路径前缀
      const relative = cwd.replace(os.homedir() + '/', '');
      // 取第一级目录作为项目名
      const parts = relative.split('/').filter(p => p && !p.startsWith('.') && p !== 'ext-global');
      if (parts.length === 0) return null;
      return parts[0];
    }

    // 解析 Codex 日志
    const codexDir = path.join(os.homedir(), ".codex", "sessions");
    try {
      const years = fs.readdirSync(codexDir);
      for (const year of years) {
        const yearPath = path.join(codexDir, year);
        if (!fs.statSync(yearPath).isDirectory()) continue;
        const months = fs.readdirSync(yearPath);
        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          if (!fs.statSync(monthPath).isDirectory()) continue;
          const days = fs.readdirSync(monthPath);
          for (const day of days) {
            const dayPath = path.join(monthPath, day);
            if (!fs.statSync(dayPath).isDirectory()) continue;
            const files = fs.readdirSync(dayPath).filter(f => f.endsWith('.jsonl'));
            for (const file of files.slice(0, 200)) { // 增加文件数量限制
              const filePath = path.join(dayPath, file);
              try {
                const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
                const data = JSON.parse(firstLine);
                // 优先从 git URL 解析
                if (data.git?.repository_url) {
                  const parsed = parseGitUrl(data.git.repository_url);
                  if (parsed) {
                    const projectKey = `${parsed.owner}/${parsed.repo}`;
                    if (!projectMap.has(projectKey)) {
                      projectMap.set(projectKey, {
                        project_key: projectKey,
                        project_ref: data.git.repository_url,
                        source: 'codex',
                        count: 0
                      });
                    }
                    projectMap.get(projectKey).count++;
                  }
                }
              } catch (e) { /* ignore */ }
            }
          }
        }
      }
    } catch (e) { /* ignore */ }

    // 解析 Claude 项目日志（递归查找所有 subagents 目录）
    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    function findSubagentsDirs(dir, depth = 0) {
      const results = [];
      if (depth > 3) return results; // 限制递归深度
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (!stat.isDirectory()) continue;
          if (item === 'subagents') {
            results.push(fullPath);
          } else {
            results.push(...findSubagentsDirs(fullPath, depth + 1));
          }
        }
      } catch (e) { /* ignore */ }
      return results;
    }

    try {
      const subagentsDirs = findSubagentsDirs(claudeDir);
      for (const subagentsPath of subagentsDirs) {
        const files = fs.readdirSync(subagentsPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files.slice(0, 100)) {
          const filePath = path.join(subagentsPath, file);
          try {
            const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
            if (!firstLine) continue;
            const data = JSON.parse(firstLine);
            const projectName = extractProjectFromCwd(data.cwd);
            if (projectName) {
              if (!projectMap.has(projectName)) {
                projectMap.set(projectName, {
                  project_key: projectName,
                  project_ref: `file://${data.cwd}`,
                  source: 'claude',
                  count: 0
                });
              }
              projectMap.get(projectName).count++;
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }

    // 从 queue 数据按项目活跃度分配 token
    const rows = readQueueData();
    const totalTokens = rows.reduce((sum, row) => sum + (row.total_tokens || 0), 0);
    const entries = [];

    if (projectMap.size === 0) {
      // 备用：按 source 分组
      const bySource = new Map();
      for (const row of rows) {
        const source = row.source || "unknown";
        if (!bySource.has(source)) {
          bySource.set(source, {
            project_key: source,
            project_ref: `https://${source}.ai`,
            total_tokens: 0,
            billable_total_tokens: 0
          });
        }
        bySource.get(source).total_tokens += row.total_tokens || 0;
        bySource.get(source).billable_total_tokens += row.total_tokens || 0;
      }
      entries.push(...Array.from(bySource.values()).sort((a, b) => b.billable_total_tokens - a.total_tokens).map(e => ({
        ...e,
        total_tokens: String(e.total_tokens),
        billable_total_tokens: String(e.billable_total_tokens)
      })));
    } else {
      // 按项目活跃度（count）分配 token
      const totalCount = Array.from(projectMap.values()).reduce((sum, p) => sum + p.count, 0);
      for (const [, project] of projectMap) {
        const ratio = totalCount > 0 ? project.count / totalCount : 1 / projectMap.size;
        const tokens = Math.floor(totalTokens * ratio);
        entries.push({
          project_key: project.project_key,
          project_ref: project.project_ref,
          total_tokens: String(tokens),
          billable_total_tokens: String(tokens)
        });
      }
      // 按 token 数排序
      entries.sort((a, b) => Number(b.billable_total_tokens) - Number(a.billable_total_tokens));
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      generated_at: new Date().toISOString(),
      entries
    }));
    return true;
  }

  // 处理 usage-limits
  if (pathname === "/functions/tokentracker-usage-limits") {
    try {
      const esmRequire = createRequire(import.meta.url);
      const { getUsageLimits, resetUsageLimitsCache } = esmRequire("../src/lib/usage-limits");
      const forceRefresh = url.searchParams.get("refresh");
      if (forceRefresh === "1" || forceRefresh === "true") {
        resetUsageLimitsCache();
      }
      const data = await getUsageLimits({
        home: os.homedir(),
        env: process.env,
        platform: process.platform,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e?.message || "Unknown error" }));
    }
    return true;
  }

  // 处理 user-status
  if (pathname === "/functions/tokentracker-user-status") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      user_id: "local-user", email: "local@localhost", name: "Local User", is_public: false,
      created_at: new Date().toISOString(),
      pro: { active: true, sources: ["local"], expires_at: null, partial: false, as_of: new Date().toISOString() },
    }));
    return true;
  }

  return null;
}

async function proxyToLocalCli(req, res) {
  const target = `http://127.0.0.1:7680${req.url}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  const init = { method: req.method, headers };
  if (req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, init);
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key === "content-encoding" || key === "content-length") return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: `Local CLI not reachable on :7680 — start it with: node bin/tracker.js serve --no-sync --no-open`,
      detail: String(error?.message || error),
    }));
  }
}

function localDataApiPlugin() {
  return {
    name: "tokentracker-local-data-api",
    configureServer(server) {
      // 添加中间件到最前面，拦截所有请求
      server.middlewares.use((req, res, next) => {
        if (typeof req.url === "string" && req.url.startsWith("/functions/")) {
          const url = new URL(req.url, `http://${req.headers.host}`);
          Promise.resolve(handleLocalApi(req, res, url))
            .then((handled) => {
              if (handled) return;
              // Mock 没识别的 endpoint → 转发到仓库 CLI（7680）
              return proxyToLocalCli(req, res);
            })
            .catch(next);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT_DIR, "VITE_");
  const fallbackVersion = loadAppVersion();
  const define = {};

  if (!env.VITE_APP_VERSION && fallbackVersion) {
    define["import.meta.env.VITE_APP_VERSION"] = JSON.stringify(fallbackVersion);
  }

  return {
    plugins: [react(), richLinkMetaPlugin(), localDataApiPlugin()],
    ...(Object.keys(define).length ? { define } : {}),
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(ROOT_DIR, "index.html"),
          share: path.resolve(ROOT_DIR, "share.html"),
          wrapped: path.resolve(ROOT_DIR, "wrapped-2025.html"),
        },
      },
    },
    server: {
      port: 5173,
      // Prefer 5173 for local CLI integration, but don't fail if already in use.
      strictPort: false,
      // 确保 API 请求不被 SPA fallback 处理
      historyApiFallback: {
        rewrites: [
          { from: /^\/functions\/.*$/, to: (ctx) => ctx.parsedUrl.pathname }
        ]
      },
      // 代理 InsForge auth/functions 请求到云端，避免跨域 cookie 问题
      proxy: (() => {
        const target = loadEnv("development", ROOT_DIR, "VITE_").VITE_INSFORGE_BASE_URL;
        if (!target) return {};
        return {
          "/api/auth": {
            target,
            changeOrigin: true,
            secure: true,
            cookieDomainRewrite: "localhost",
          },
        };
      })(),
    },
  };
});
