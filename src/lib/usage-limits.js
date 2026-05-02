const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const { readClaudeCodeAccessToken, readCodexAccessToken } = require("./subscriptions");
const {
  isCursorInstalled,
  extractCursorSessionToken,
  fetchCursorUsageSummary,
} = require("./cursor-config");

// 2-minute in-memory cache
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usedPercent, resetAt }) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  const padLen = (4 - (payload.length % 4)) % 4;
  const padded = payload + "=".repeat(padLen);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeAbortSignals(signalA, signalB) {
  if (!signalA) return signalB;
  if (!signalB) return signalA;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signalA, signalB]);
  }
  return signalA;
}

function withFetchTimeout(fetchImpl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl;
  return (url, options = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return fetchImpl(url, {
      ...options,
      signal: mergeAbortSignals(options.signal, timeoutSignal),
    });
  };
}

function withProviderTimeout(promise, label, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} usage request timed out.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchClaudeUsageLimits(accessToken, { fetchImpl = fetch, maxAttempts = 3 } = {}) {
  const url = "https://api.anthropic.com/api/oauth/usage";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchImpl(url, { method: "GET", headers });
    if (res.status === 401) {
      throw new Error("token_expired");
    }
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts - 1) {
      const ra = res.headers.get("retry-after");
      const sec = ra ? Number.parseInt(ra, 10) : NaN;
      const delayMs = Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 30_000) : 1500 * (attempt + 1);
      await sleepMs(delayMs);
      continue;
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error(
          "Claude API rate limited (429). Too many usage checks — wait ~1 minute and refresh.",
        );
      }
      throw new Error(`Claude API returned ${res.status}`);
    }
    const body = await res.json();
    return {
      five_hour: body.five_hour ?? null,
      seven_day: body.seven_day ?? null,
      seven_day_opus: body.seven_day_opus ?? null,
      extra_usage: body.extra_usage ?? null,
    };
  }
}

async function fetchCodexUsageLimits(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Codex API returned ${res.status}`);
  }
  const body = await res.json();
  const rateLimit = body.rate_limit || {};
  return {
    primary_window: rateLimit.primary_window ?? null,
    secondary_window: rateLimit.secondary_window ?? null,
  };
}

function cursorPercentFromCentsUsedLimit(usedRaw, limitRaw) {
  const used = Number(usedRaw);
  const limit = Number(limitRaw);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function normalizeCursorUsageSummary(body) {
  const plan = body?.individualUsage?.plan || null;
  const indOnDemand = body?.individualUsage?.onDemand || null;
  const teamOnDemand = body?.teamUsage?.onDemand || null;
  const billingCycleEnd = typeof body?.billingCycleEnd === "string" ? body.billingCycleEnd : null;
  const autoPercent = clampPercent(plan?.autoPercentUsed);
  const apiPercent = clampPercent(plan?.apiPercentUsed);

  // Prefer totalPercentUsed, then Auto/API lanes (aligned with CodexBar): raw plan used/limit
  // are often cents where limit can be price/cap semantics — do not prefer that over percent lanes.
  let planPercent = clampPercent(plan?.totalPercentUsed);
  if (planPercent === null) {
    if (autoPercent !== null && apiPercent !== null) {
      planPercent = clampPercent((autoPercent + apiPercent) / 2);
    } else if (apiPercent !== null) {
      planPercent = apiPercent;
    } else if (autoPercent !== null) {
      planPercent = autoPercent;
    } else {
      const fromPlanCents = cursorPercentFromCentsUsedLimit(plan?.used, plan?.limit);
      if (fromPlanCents !== null) planPercent = fromPlanCents;
    }
  }
  if (planPercent === null) {
    const fromInd = cursorPercentFromCentsUsedLimit(indOnDemand?.used, indOnDemand?.limit);
    if (fromInd !== null) planPercent = fromInd;
  }
  if (planPercent === null) {
    const fromTeam = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (fromTeam !== null) planPercent = fromTeam;
  }
  // Enterprise / team: individualUsage.plan often stays at 0% while pooled usage is on teamUsage.onDemand.
  if (planPercent === 0) {
    const fromInd = cursorPercentFromCentsUsedLimit(indOnDemand?.used, indOnDemand?.limit);
    if (fromInd !== null && fromInd > 0) planPercent = fromInd;
  }
  if (planPercent === 0) {
    const fromTeam = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (fromTeam !== null && fromTeam > 0) planPercent = fromTeam;
  }

  // Team / enterprise: headline usage is the pooled quota (teamUsage.onDemand), not individual lanes.
  const limitType = typeof body?.limitType === "string" ? body.limitType : "";
  const membershipTypeStr = typeof body?.membershipType === "string" ? body.membershipType : "";
  const preferTeamPool =
    limitType === "team" ||
    membershipTypeStr === "enterprise" ||
    membershipTypeStr === "team";
  if (preferTeamPool) {
    const teamHeadline = cursorPercentFromCentsUsedLimit(teamOnDemand?.used, teamOnDemand?.limit);
    if (teamHeadline !== null && (planPercent === null || planPercent === 0)) {
      planPercent = teamHeadline;
    }
  }

  return {
    membership_type: typeof body?.membershipType === "string" ? body.membershipType : null,
    primary_window: buildWindow({ usedPercent: planPercent, resetAt: billingCycleEnd }),
    secondary_window: buildWindow({ usedPercent: autoPercent, resetAt: billingCycleEnd }),
    tertiary_window: buildWindow({ usedPercent: apiPercent, resetAt: billingCycleEnd }),
  };
}

async function fetchCursorLimits({ home, fetchImpl = fetch } = {}) {
  if (!isCursorInstalled({ home })) {
    return { configured: false };
  }
  const auth = extractCursorSessionToken({ home });
  if (!auth?.cookie) {
    return { configured: false };
  }
  try {
    const body = await fetchCursorUsageSummary({ cookie: auth.cookie, fetchImpl });
    return {
      configured: true,
      error: null,
      ...normalizeCursorUsageSummary(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function resolveKimiHome({ home, env } = {}) {
  const explicit = typeof env?.KIMI_HOME === "string" ? env.KIMI_HOME.trim() : "";
  return explicit ? path.resolve(explicit) : path.join(home || os.homedir(), ".kimi");
}

function loadKimiCredentials({ home, env } = {}) {
  const kimiHome = resolveKimiHome({ home, env });
  const credsPath = path.join(kimiHome, "credentials", "kimi-code.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function hasKimiConfig({ home, env } = {}) {
  return fs.existsSync(path.join(resolveKimiHome({ home, env }), "config.toml"));
}

function kimiNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function kimiResetTime(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function kimiWindowFromUsage(data) {
  if (!data || typeof data !== "object") return null;
  const limit = kimiNumber(data.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  let used = kimiNumber(data.used);
  if (used === null) {
    const remaining = kimiNumber(data.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (!Number.isFinite(used)) return null;
  return buildWindow({
    usedPercent: (used / limit) * 100,
    resetAt: kimiResetTime(data.resetTime || data.reset_at || data.resetAt),
  });
}

function normalizeKimiUsageResponse(body) {
  const firstLimit = Array.isArray(body?.limits) ? body.limits[0] : null;
  const detail = firstLimit?.detail && typeof firstLimit.detail === "object" ? firstLimit.detail : firstLimit;
  const parallelLimit = kimiNumber(body?.parallel?.limit);

  return {
    membership_level: typeof body?.user?.membership?.level === "string" ? body.user.membership.level : null,
    subscription_type: typeof body?.subType === "string" ? body.subType : null,
    parallel_limit: parallelLimit !== null ? parallelLimit : null,
    primary_window: kimiWindowFromUsage(body?.usage),
    secondary_window: kimiWindowFromUsage(detail),
    tertiary_window: kimiWindowFromUsage(body?.totalQuota),
  };
}

async function fetchKimiLimits({ home, env, fetchImpl = fetch } = {}) {
  if (!hasKimiConfig({ home, env })) {
    return { configured: false };
  }
  const creds = loadKimiCredentials({ home, env });
  const accessToken = typeof creds?.access_token === "string" ? creds.access_token.trim() : "";
  if (!accessToken) {
    return { configured: false };
  }
  try {
    const res = await fetchImpl("https://api.kimi.com/coding/v1/usages", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (res.status === 401) {
      throw new Error("token_expired");
    }
    if (!res.ok) {
      throw new Error(`Kimi API returned ${res.status}`);
    }
    const body = await res.json();
    return {
      configured: true,
      error: null,
      ...normalizeKimiUsageResponse(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function resolveGeminiHome({ home, env } = {}) {
  const explicit = typeof env?.GEMINI_HOME === "string" ? env.GEMINI_HOME.trim() : "";
  return explicit ? path.resolve(explicit) : path.join(home, ".gemini");
}

function loadGeminiSettings({ home, env } = {}) {
  const geminiHome = resolveGeminiHome({ home, env });
  const settingsPath = path.join(geminiHome, "settings.json");
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function loadGeminiCredentials({ home, env } = {}) {
  const geminiHome = resolveGeminiHome({ home, env });
  const credsPath = path.join(geminiHome, "oauth_creds.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function resolveSymlinkOnce(filePath) {
  try {
    const resolved = fs.readlinkSync(filePath);
    return path.isAbsolute(resolved)
      ? resolved
      : path.join(path.dirname(filePath), resolved);
  } catch (_error) {
    return filePath;
  }
}

function expandGeminiExecutableCandidates({ home } = {}) {
  const candidates = [];
  const add = (filePath) => {
    if (typeof filePath === "string" && filePath && !candidates.includes(filePath)) {
      candidates.push(filePath);
    }
  };

  const nvmDir = path.join(home || os.homedir(), ".nvm", "versions", "node");
  try {
    for (const version of fs.readdirSync(nvmDir)) {
      add(path.join(nvmDir, version, "bin", "gemini"));
    }
  } catch (_error) {}

  add(path.join(path.dirname(resolveSymlinkOnce(process.execPath)), "gemini"));
  add("/opt/homebrew/bin/gemini");
  add("/usr/local/bin/gemini");

  return candidates;
}

function extractGeminiOauthClientCredentials({ commandRunner, home } = {}) {
  const result = runCommand(commandRunner, "which", ["gemini"], { timeout: 2000 });
  const geminiPath = typeof result?.stdout === "string" ? result.stdout.trim() : "";

  const geminiPaths = [
    ...(geminiPath ? [geminiPath] : []),
    ...expandGeminiExecutableCandidates({ home }),
  ];

  for (const candidateGeminiPath of geminiPaths) {
    if (!fs.existsSync(candidateGeminiPath)) continue;
    const realPath = resolveSymlinkOnce(candidateGeminiPath);
    const binDir = path.dirname(realPath);
    const baseDir = path.dirname(binDir);
    const bundleDir = path.dirname(realPath);
    const candidates = [
      path.join(baseDir, "libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "share/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "../gemini-cli-core/dist/src/code_assist/oauth2.js"),
      path.join(baseDir, "node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
    ];
    if (path.basename(bundleDir) === "bundle") {
      candidates.push(realPath);
      try {
        for (const file of fs.readdirSync(bundleDir)) {
          if (/^chunk-.*\.js$/.test(file)) {
            candidates.push(path.join(bundleDir, file));
          }
        }
      } catch (_error) {}
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const content = fs.readFileSync(candidate, "utf8");
        const clientId = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] || null;
        const clientSecret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1] || null;
        if (clientId && clientSecret) {
          return { clientId, clientSecret };
        }
      } catch (_error) {}
    }
  }
  return null;
}

async function refreshGeminiAccessToken({
  refreshToken,
  home,
  env,
  fetchImpl = fetch,
  commandRunner,
}) {
  const oauthClient = extractGeminiOauthClientCredentials({ commandRunner, home });
  if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
    throw new Error("Gemini API error: Could not find Gemini CLI OAuth configuration");
  }

  const body = new URLSearchParams({
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error("Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.");
  }

  const json = await res.json();
  if (!json?.access_token) {
    throw new Error("Could not parse Gemini usage: invalid token refresh response");
  }

  const geminiHome = resolveGeminiHome({ home, env });
  const credsPath = path.join(geminiHome, "oauth_creds.json");
  try {
    const creds = loadGeminiCredentials({ home, env }) || {};
    creds.access_token = json.access_token;
    if (json.id_token) creds.id_token = json.id_token;
    if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in)) {
      creds.expiry_date = Date.now() + json.expires_in * 1000;
    }
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
  } catch (_error) {}

  return json.access_token;
}

async function loadGeminiCodeAssistStatus(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
  });
  if (!res.ok) {
    return { tier: null, projectId: null };
  }
  const json = await res.json();
  const tier = typeof json?.currentTier?.id === "string" ? json.currentTier.id : null;
  const rawProject = json?.cloudaicompanionProject;
  const projectId =
    typeof rawProject === "string"
      ? rawProject.trim() || null
      : typeof rawProject?.id === "string"
        ? rawProject.id
        : typeof rawProject?.projectId === "string"
          ? rawProject.projectId
          : null;
  return { tier, projectId };
}

function normalizeGeminiModelBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  const byModel = new Map();
  for (const bucket of buckets) {
    const modelId = typeof bucket?.modelId === "string" ? bucket.modelId : null;
    const remainingFraction = Number(bucket?.remainingFraction);
    if (!modelId || !Number.isFinite(remainingFraction)) continue;
    const existing = byModel.get(modelId);
    if (!existing || remainingFraction < existing.remainingFraction) {
      byModel.set(modelId, {
        model_id: modelId,
        remainingFraction,
        reset_at: parseAntigravityDate(bucket?.resetTime),
      });
    }
  }
  return Array.from(byModel.values()).sort((a, b) => a.model_id.localeCompare(b.model_id));
}

function isGeminiFlashLiteModel(id) {
  return String(id || "").toLowerCase().includes("flash-lite");
}

function isGeminiFlashModel(id) {
  const lower = String(id || "").toLowerCase();
  return lower.includes("flash") && !isGeminiFlashLiteModel(lower);
}

function isGeminiProModel(id) {
  return String(id || "").toLowerCase().includes("pro");
}

function normalizeGeminiQuotaResponse({ buckets, email, tier }) {
  const models = normalizeGeminiModelBuckets(buckets);
  if (!models.length) {
    throw new Error("Could not parse Gemini usage: no quota buckets in response");
  }

  const pickLowest = (predicate) =>
    models
      .filter((model) => predicate(model.model_id))
      .sort((a, b) => a.remainingFraction - b.remainingFraction)[0] || null;

  const plan =
    tier === "standard-tier"
      ? "Paid"
      : tier === "legacy-tier"
        ? "Legacy"
        : tier === "free-tier"
          ? "Free"
          : null;

  const pro = pickLowest(isGeminiProModel);
  const flash = pickLowest(isGeminiFlashModel);
  const flashLite = pickLowest(isGeminiFlashLiteModel);
  const fallback = !pro && !flash && !flashLite
    ? [...models].sort((a, b) => a.remainingFraction - b.remainingFraction)[0]
    : null;

  const toWindow = (model) =>
    model
      ? buildWindow({
          usedPercent: 100 - model.remainingFraction * 100,
          resetAt: model.reset_at,
        })
      : null;

  return {
    account_email: email || null,
    account_plan: plan,
    primary_window: toWindow(pro || fallback),
    secondary_window: toWindow(flash),
    tertiary_window: toWindow(flashLite),
  };
}

async function fetchGeminiLimits({ home, env, fetchImpl = fetch, commandRunner } = {}) {
  const settings = loadGeminiSettings({ home, env });
  const selectedType = settings?.security?.auth?.selectedType ?? null;
  if (!settings && !loadGeminiCredentials({ home, env })) {
    return { configured: false };
  }
  if (selectedType === "api-key") {
    return { configured: true, error: "Gemini API key auth not supported. Use Google account (OAuth) instead." };
  }
  if (selectedType === "vertex-ai") {
    return { configured: true, error: "Gemini Vertex AI auth not supported. Use Google account (OAuth) instead." };
  }

  const creds = loadGeminiCredentials({ home, env });
  if (!creds?.access_token) {
    return { configured: true, error: "Not logged in to Gemini. Run 'gemini' in Terminal to authenticate." };
  }

  try {
    let accessToken = creds.access_token;
    const expiry = Number(creds.expiry_date);
    if (Number.isFinite(expiry) && expiry > 0 && expiry < Date.now() && creds.refresh_token) {
      accessToken = await refreshGeminiAccessToken({
        refreshToken: creds.refresh_token,
        home,
        env,
        fetchImpl,
        commandRunner,
      });
    }

    const claims = decodeJwtPayload(creds.id_token);
    const codeAssist = await loadGeminiCodeAssistStatus(accessToken, { fetchImpl });
    const res = await fetchImpl("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(codeAssist.projectId ? { project: codeAssist.projectId } : {}),
    });
    if (res.status === 401) {
      throw new Error("Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.");
    }
    if (!res.ok) {
      throw new Error(`Gemini API error: HTTP ${res.status}`);
    }
    const json = await res.json();
    return {
      configured: true,
      error: null,
      ...normalizeGeminiQuotaResponse({
        buckets: json?.buckets,
        email: claims?.email || null,
        tier: codeAssist.tier,
      }),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function runCommand(commandRunner, command, args, options = {}) {
  const runner = typeof commandRunner === "function" ? commandRunner : cp.spawnSync;
  return runner(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function isBinaryAvailable(binary, { commandRunner } = {}) {
  const result = runCommand(commandRunner, "which", [binary], { timeout: 2000 });
  return !result?.error && result?.status === 0;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

function extractFirstNumber(text) {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseMonthDayResetDate(dateStr, now = new Date()) {
  if (typeof dateStr !== "string") return null;
  const match = dateStr.match(/(\d{2})\/(\d{2})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  const currentYear = now.getUTCFullYear();

  let candidate = new Date(Date.UTC(currentYear, month - 1, day, 0, 0, 0, 0));
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(Date.UTC(currentYear + 1, month - 1, day, 0, 0, 0, 0));
  }
  return candidate.toISOString();
}

function isKiroUsageOutputComplete(output) {
  const lowered = stripAnsi(output).toLowerCase();
  return lowered.includes("covered in plan")
    || lowered.includes("resets on")
    || lowered.includes("bonus credits")
    || lowered.includes("plan:")
    || lowered.includes("managed by admin")
    || lowered.includes("managed by organization");
}

function parseKiroUsageOutput(output, { now = new Date() } = {}) {
  const stripped = stripAnsi(output).trim();
  if (!stripped) {
    throw new Error("Failed to parse Kiro usage: empty output");
  }

  const lowered = stripped.toLowerCase();
  if (
    lowered.includes("not logged in")
    || lowered.includes("login required")
    || lowered.includes("failed to initialize auth portal")
    || lowered.includes("kiro-cli login")
    || lowered.includes("oauth error")
  ) {
    throw new Error("Not logged in to Kiro. Run 'kiro-cli login' first.");
  }
  if (lowered.includes("could not retrieve usage information")) {
    throw new Error("Failed to parse Kiro usage: Kiro CLI could not retrieve usage information.");
  }

  let planName = "Kiro";
  const legacyPlan = stripped.match(/\|\s*(KIRO\s+\w+)/);
  if (legacyPlan?.[1]) {
    planName = legacyPlan[1].trim();
  }
  const modernPlan = stripped.match(/Plan:\s*(.+)/);
  if (modernPlan?.[1]) {
    planName = modernPlan[1].split("\n")[0].trim() || planName;
  }

  const resetMatch = stripped.match(/resets on (\d{2}\/\d{2})/i);
  const primaryReset = resetMatch ? parseMonthDayResetDate(resetMatch[1], now) : null;

  let creditsPercent = null;
  const percentMatch = stripped.match(/█+\s*(\d+)%/);
  if (percentMatch?.[1]) {
    creditsPercent = clampPercent(Number(percentMatch[1]));
  }

  let creditsUsed = null;
  let creditsTotal = null;
  const coveredMatch = stripped.match(/\((\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+covered/i);
  if (coveredMatch?.[1] && coveredMatch?.[2]) {
    creditsUsed = Number(coveredMatch[1]);
    creditsTotal = Number(coveredMatch[2]);
  }
  if (creditsPercent === null && creditsUsed !== null && creditsTotal && creditsTotal > 0) {
    creditsPercent = clampPercent((creditsUsed / creditsTotal) * 100);
  }

  const managedPlan = lowered.includes("managed by admin") || lowered.includes("managed by organization");
  if (creditsPercent === null && creditsUsed === null && managedPlan) {
    return {
      plan_name: planName,
      primary_window: buildWindow({ usedPercent: 0, resetAt: null }),
      secondary_window: null,
    };
  }
  if (creditsPercent === null && creditsUsed === null) {
    throw new Error("Failed to parse Kiro usage: usage output format may have changed.");
  }

  let bonusWindow = null;
  const bonusMatch = stripped.match(/Bonus credits:[\s\S]*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/i);
  const expiryMatch = stripped.match(/expires in (\d+) days?/i);
  if (bonusMatch?.[1] && bonusMatch?.[2]) {
    const bonusUsed = Number(bonusMatch[1]);
    const bonusTotal = Number(bonusMatch[2]);
    const bonusPct = bonusTotal > 0 ? clampPercent((bonusUsed / bonusTotal) * 100) : 0;
    let bonusReset = null;
    if (expiryMatch?.[1]) {
      const days = Number(expiryMatch[1]);
      if (Number.isFinite(days) && days >= 0) {
        bonusReset = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    bonusWindow = buildWindow({ usedPercent: bonusPct, resetAt: bonusReset });
  }

  return {
    plan_name: planName,
    primary_window: buildWindow({ usedPercent: creditsPercent, resetAt: primaryReset }),
    secondary_window: bonusWindow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot — `GET https://api.github.com/copilot_internal/user`
// Reuses the OAuth token from the user's existing Copilot install
// (`~/.config/github-copilot/{apps,hosts}.json`). No device flow needed.
// ─────────────────────────────────────────────────────────────────────────────

function readCopilotOauthToken({ home = require("node:os").homedir() } = {}) {
  const candidates = [
    path.join(home, ".config", "github-copilot", "apps.json"),
    path.join(home, ".config", "github-copilot", "hosts.json"),
  ];
  // Keys are either "github.com", "github.example.com" (enterprise), or a
  // composite like "github.com:Iv1.b507a08c87ecfe98". We always hit
  // api.github.com, so prefer the public-host token; only fall back to
  // whatever's there if no public-host entry exists.
  let fallback = null;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_e) {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const token = typeof value.oauth_token === "string" ? value.oauth_token : "";
      if (!token) continue;
      const host = String(key).split(":")[0];
      if (host === "github.com") return token;
      if (!fallback) fallback = token;
    }
  }
  return fallback;
}

function copilotRequestHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "Editor-Version": "vscode/1.96.2",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-Github-Api-Version": "2025-04-01",
  };
}

function copilotResetIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  // Accept "YYYY-MM-DD" or full ISO timestamps
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const ts = Date.parse(dateOnly ? `${trimmed}T00:00:00Z` : trimmed);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function buildCopilotWindow(snapshot, resetIso) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const entitlement = Number(snapshot.entitlement);
  const remaining = Number(snapshot.remaining);
  const percentRemaining = Number(snapshot.percent_remaining);
  const allZero = (!entitlement || entitlement <= 0) && (!remaining || remaining <= 0) && (!percentRemaining || percentRemaining <= 0);
  if (allZero) return null;
  let usedPercent;
  if (Number.isFinite(percentRemaining)) {
    usedPercent = 100 - percentRemaining;
  } else if (Number.isFinite(entitlement) && entitlement > 0 && Number.isFinite(remaining)) {
    usedPercent = ((entitlement - remaining) / entitlement) * 100;
  } else {
    return null;
  }
  return buildWindow({ usedPercent, resetAt: resetIso });
}

function describeCopilotOtelStatus({ home, env = process.env } = {}) {
  const resolvedHome = home || env.HOME || require("node:os").homedir();
  const enabled = String(env.COPILOT_OTEL_ENABLED || "").toLowerCase() === "true";
  const exporterType = String(env.COPILOT_OTEL_EXPORTER_TYPE || "").toLowerCase();
  const explicitPath = typeof env.COPILOT_OTEL_FILE_EXPORTER_PATH === "string"
    ? env.COPILOT_OTEL_FILE_EXPORTER_PATH
    : "";
  const defaultDir = path.join(resolvedHome, ".copilot", "otel");
  let hasFiles = false;
  try {
    if (fs.existsSync(defaultDir)) {
      hasFiles = fs.readdirSync(defaultDir).some((entry) => entry.endsWith(".jsonl"));
    }
  } catch (_e) {}
  if (!hasFiles && explicitPath && fs.existsSync(explicitPath)) hasFiles = true;
  return {
    otel_enabled: enabled && (exporterType === "" || exporterType === "file"),
    otel_exporter_type: exporterType || null,
    otel_path: explicitPath || null,
    otel_default_dir: defaultDir,
    otel_has_files: hasFiles,
  };
}

async function fetchCopilotLimits({ home, env = process.env, fetchImpl = fetch } = {}) {
  const otel = describeCopilotOtelStatus({ home, env });
  const token = readCopilotOauthToken({ home: home || (env.HOME || require("node:os").homedir()) });
  if (!token) return { configured: false, ...otel };

  try {
    const res = await fetchImpl("https://api.github.com/copilot_internal/user", {
      method: "GET",
      headers: copilotRequestHeaders(token),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("GitHub Copilot token rejected. Re-authenticate via GitHub Copilot CLI/extension.");
    }
    if (!res.ok) {
      throw new Error(`GitHub Copilot API error: HTTP ${res.status}`);
    }
    const json = await res.json();
    const planName = typeof json?.copilot_plan === "string" && json.copilot_plan
      ? json.copilot_plan.charAt(0).toUpperCase() + json.copilot_plan.slice(1)
      : null;
    const resetIso = copilotResetIso(json?.quota_reset_date);
    const snapshots = json?.quota_snapshots || {};
    const premiumWindow = buildCopilotWindow(snapshots.premium_interactions, resetIso);
    const chatWindow = buildCopilotWindow(snapshots.chat, resetIso);

    if (!premiumWindow && !chatWindow) {
      return { configured: true, error: null, plan_name: planName, primary_window: null, secondary_window: null, ...otel };
    }

    return {
      configured: true,
      error: null,
      plan_name: planName,
      primary_window: premiumWindow,
      secondary_window: chatWindow,
      ...otel,
    };
  } catch (error) {
    return { configured: true, error: error?.message || "Unknown error", ...otel };
  }
}

function fetchKiroLimits({ commandRunner, now = new Date() } = {}) {
  if (!isBinaryAvailable("kiro-cli", { commandRunner })) {
    return { configured: false };
  }

  const result = runCommand(
    commandRunner,
    "kiro-cli",
    ["chat", "--no-interactive", "/usage"],
    {
      timeout: 20_000,
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );

  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const output = stderr.trim() || stdout.trim();

  try {
    if (result?.error?.code === "ETIMEDOUT" && !isKiroUsageOutputComplete(output)) {
      throw new Error("Kiro CLI timed out.");
    }
    if (!output && result?.status !== 0) {
      throw new Error(`Kiro CLI failed with status ${result.status}.`);
    }

    return {
      configured: true,
      error: null,
      ...parseKiroUsageOutput(output, { now }),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

function parseProcessLine(line) {
  const match = String(line || "")
    .trim()
    .match(/^(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    command: match[2],
  };
}

function isAntigravityCommandLine(command) {
  const lower = String(command || "").toLowerCase();
  return lower.includes("language_server_macos")
    && (
      (lower.includes("--app_data_dir") && lower.includes("antigravity"))
      || lower.includes("/antigravity/")
      || lower.includes("\\antigravity\\")
    );
}

function extractCommandFlag(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(command || "").match(new RegExp(`${escaped}[=\\s]+([^\\s]+)`, "i"));
  return match?.[1] || null;
}

function detectAntigravityProcess({ commandRunner } = {}) {
  const result = runCommand(commandRunner, "/bin/ps", ["-ax", "-o", "pid=,command="], {
    timeout: 4000,
  });
  const lines = String(result?.stdout || "").split("\n");

  let sawProcess = false;
  for (const line of lines) {
    const parsed = parseProcessLine(line);
    if (!parsed) continue;
    if (!isAntigravityCommandLine(parsed.command)) continue;
    sawProcess = true;
    const csrfToken = extractCommandFlag(parsed.command, "--csrf_token");
    if (!csrfToken) continue;
    const extensionPort = extractFirstNumber(extractCommandFlag(parsed.command, "--extension_server_port"));
    return {
      configured: true,
      pid: parsed.pid,
      csrfToken,
      extensionPort: Number.isFinite(extensionPort) ? extensionPort : null,
    };
  }

  if (sawProcess) {
    return { configured: true, error: "Antigravity CSRF token not found. Restart Antigravity and retry." };
  }
  return { configured: false };
}

function resolveLsofBinary() {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseListeningPorts(output) {
  const matches = String(output || "").matchAll(/:(\d+)\s+\(LISTEN\)/g);
  const ports = new Set();
  for (const match of matches) {
    const port = Number(match[1]);
    if (Number.isFinite(port)) {
      ports.add(port);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

function listAntigravityPorts(pid, { commandRunner } = {}) {
  const lsof = resolveLsofBinary();
  if (!lsof) {
    throw new Error("Antigravity port detection needs lsof. Install it, then retry.");
  }
  const result = runCommand(
    commandRunner,
    lsof,
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    { timeout: 4000 },
  );
  const ports = parseListeningPorts(result?.stdout);
  if (!ports.length) {
    throw new Error("Antigravity is running but not exposing ports yet. Try again in a few seconds.");
  }
  return ports;
}

function antigravityDefaultBody() {
  return {
    metadata: {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    },
  };
}

function antigravityUnleashBody() {
  return {
    context: {
      properties: {
        devMode: "false",
        extensionVersion: "unknown",
        hasAnthropicModelAccess: "true",
        ide: "antigravity",
        ideVersion: "unknown",
        installationId: "tokentracker",
        language: "UNSPECIFIED",
        os: "macos",
        requestedModelId: "MODEL_UNSPECIFIED",
      },
    },
  };
}

function requestLocalJson({
  scheme,
  port,
  path,
  body,
  csrfToken,
  timeoutMs = 8000,
  requestFn,
}) {
  if (typeof requestFn === "function") {
    return requestFn({ scheme, port, path, body, csrfToken, timeoutMs });
  }

  const client = scheme === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(body);
    const req = client.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(rawBody);
    req.end();
  });
}

function antigravityCodeIsOk(code) {
  if (code === null || code === undefined) return true;
  if (typeof code === "number") return code === 0;
  if (typeof code === "string") {
    const lower = code.toLowerCase();
    return lower === "ok" || lower === "success" || lower === "0";
  }
  return false;
}

function parseAntigravityDate(value) {
  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(numeric * 1000).toISOString();
    }
    if (Number.isFinite(numeric)) return null;
    const iso = Date.parse(value);
    if (Number.isFinite(iso) && iso > 0) return new Date(iso).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function parseAntigravityModelConfigs(configs) {
  if (!Array.isArray(configs)) return [];
  return configs
    .map((config) => {
      const quota = config?.quotaInfo || null;
      if (!quota) return null;
      return {
        label: typeof config?.label === "string" ? config.label : "",
        model_id: typeof config?.modelOrAlias?.model === "string" ? config.modelOrAlias.model : "",
        remaining_fraction:
          typeof quota?.remainingFraction === "number" && Number.isFinite(quota.remainingFraction)
            ? quota.remainingFraction
            : null,
        reset_at: parseAntigravityDate(quota?.resetTime),
      };
    })
    .filter(Boolean);
}

function antigravityFamily(model) {
  const text = `${model?.label || ""} ${model?.model_id || ""}`.toLowerCase();
  if (text.includes("claude")) return "claude";
  if (text.includes("gemini") && text.includes("pro")) return "gemini_pro";
  if (text.includes("gemini") && text.includes("flash")) return "gemini_flash";
  return "unknown";
}

function antigravityPriority(model) {
  const text = `${model?.label || ""} ${model?.model_id || ""}`.toLowerCase();
  if (text.includes("lite") || text.includes("autocomplete") || text.includes("tab_")) return null;
  if (antigravityFamily(model) === "gemini_pro") {
    return text.includes("pro-low") || (text.includes("pro") && text.includes("low")) ? 0 : 1;
  }
  return 0;
}

function chooseAntigravityModel(models, family) {
  const candidates = models
    .filter((model) => antigravityFamily(model) === family)
    .map((model) => ({
      model,
      priority: antigravityPriority(model),
      remaining:
        typeof model.remaining_fraction === "number"
          ? model.remaining_fraction
          : Number.POSITIVE_INFINITY,
    }))
    .filter((entry) => entry.priority !== null);

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.remaining - b.remaining;
  });
  return candidates[0].model;
}

function makeAntigravityWindow(model) {
  if (!model) return null;
  const remaining = typeof model.remaining_fraction === "number" ? model.remaining_fraction * 100 : 0;
  return buildWindow({
    usedPercent: 100 - remaining,
    resetAt: model.reset_at,
  });
}

function normalizeAntigravityResponse(body, { fallbackToConfigs = false } = {}) {
  if (!antigravityCodeIsOk(body?.code)) {
    throw new Error(`Antigravity API error: ${body?.code}`);
  }

  const userStatus = body?.userStatus || null;
  const configs = fallbackToConfigs
    ? body?.clientModelConfigs
    : userStatus?.cascadeModelConfigData?.clientModelConfigs;
  const models = parseAntigravityModelConfigs(configs);
  if (!models.length) {
    throw new Error("Could not parse Antigravity quota: no quota models available.");
  }

  const primary = chooseAntigravityModel(models, "claude");
  const secondary = chooseAntigravityModel(models, "gemini_pro");
  const tertiary = chooseAntigravityModel(models, "gemini_flash");
  const fallback = !primary && !secondary && !tertiary
    ? [...models].sort((a, b) => {
        const aRemaining = typeof a.remaining_fraction === "number" ? a.remaining_fraction : Number.POSITIVE_INFINITY;
        const bRemaining = typeof b.remaining_fraction === "number" ? b.remaining_fraction : Number.POSITIVE_INFINITY;
        return aRemaining - bRemaining;
      })[0]
    : null;

  return {
    account_email: typeof userStatus?.email === "string" ? userStatus.email : null,
    account_plan:
      userStatus?.planStatus?.planInfo?.planDisplayName
      || userStatus?.planStatus?.planInfo?.displayName
      || userStatus?.planStatus?.planInfo?.productName
      || userStatus?.planStatus?.planInfo?.planName
      || userStatus?.planStatus?.planInfo?.planShortName
      || null,
    primary_window: makeAntigravityWindow(primary || fallback),
    secondary_window: makeAntigravityWindow(secondary),
    tertiary_window: makeAntigravityWindow(tertiary),
  };
}

async function probeAntigravityPort(port, csrfToken, { timeoutMs, requestFn } = {}) {
  try {
    await requestLocalJson({
      scheme: "https",
      port,
      path: "/exa.language_server_pb.LanguageServerService/GetUnleashData",
      body: antigravityUnleashBody(),
      csrfToken,
      timeoutMs,
      requestFn,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function fetchAntigravityLimits({ commandRunner, requestFn, timeoutMs = 8000 } = {}) {
  const processInfo = detectAntigravityProcess({ commandRunner });
  if (!processInfo.configured) {
    return { configured: false };
  }
  if (processInfo.error) {
    return { configured: true, error: processInfo.error };
  }

  try {
    const ports = listAntigravityPorts(processInfo.pid, { commandRunner });
    let workingPort = null;
    for (const port of ports) {
      if (await probeAntigravityPort(port, processInfo.csrfToken, { timeoutMs, requestFn })) {
        workingPort = port;
        break;
      }
    }
    if (!workingPort) {
      throw new Error("Antigravity port detection failed: no working API port found");
    }

    try {
      const userStatus = await requestLocalJson({
        scheme: "https",
        port: workingPort,
        path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        body: antigravityDefaultBody(),
        csrfToken: processInfo.csrfToken,
        timeoutMs,
        requestFn,
      });
      return {
        configured: true,
        error: null,
        ...normalizeAntigravityResponse(userStatus),
      };
    } catch (primaryError) {
      const fallbackPort =
        Number.isFinite(processInfo.extensionPort) && processInfo.extensionPort > 0
          ? processInfo.extensionPort
          : workingPort;
      const modelConfigs = await requestLocalJson({
        scheme: fallbackPort === workingPort ? "https" : "http",
        port: fallbackPort,
        path: "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
        body: antigravityDefaultBody(),
        csrfToken: processInfo.csrfToken,
        timeoutMs,
        requestFn,
      });
      return {
        configured: true,
        error: null,
        ...normalizeAntigravityResponse(modelConfigs, { fallbackToConfigs: true }),
      };
    }
  } catch (error) {
    const message = error?.message === "timeout"
      ? "Antigravity quota request timed out."
      : error?.message || "Unknown error";
    return {
      configured: true,
      error: message,
    };
  }
}

async function getUsageLimits({
  home,
  env,
  platform,
  securityRunner,
  fetchImpl = fetch,
  commandRunner,
  requestFn,
  now = new Date(),
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
} = {}) {
  const nowMs = Date.now();
  if (cache.data && nowMs - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const [claudeToken, codexToken] = await Promise.all([
    Promise.resolve().then(() => readClaudeCodeAccessToken({ platform, securityRunner })),
    readCodexAccessToken({ home, env }),
  ]);

  const providerFetch = withFetchTimeout(fetchImpl, providerTimeoutMs);
  const [claudeResult, codexResult, cursor, kimi, gemini, kiro, antigravity, copilot] = await Promise.all([
    claudeToken
      ? withProviderTimeout(fetchClaudeUsageLimits(claudeToken, { fetchImpl: providerFetch, maxAttempts: 1 }), "Claude", providerTimeoutMs).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        )
      : Promise.resolve(null),
    codexToken
      ? withProviderTimeout(fetchCodexUsageLimits(codexToken, { fetchImpl: providerFetch }), "Codex", providerTimeoutMs).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        )
      : Promise.resolve(null),
    withProviderTimeout(fetchCursorLimits({ home, fetchImpl: providerFetch }), "Cursor", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchKimiLimits({ home, env, fetchImpl: providerFetch }), "Kimi", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    withProviderTimeout(fetchGeminiLimits({ home, env, fetchImpl: providerFetch, commandRunner }), "Gemini", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
    Promise.resolve().then(() => fetchKiroLimits({ commandRunner, now })),
    fetchAntigravityLimits({ commandRunner, requestFn }),
    withProviderTimeout(fetchCopilotLimits({ home, env, fetchImpl: providerFetch }), "GitHub Copilot", providerTimeoutMs)
      .catch((reason) => ({ configured: true, error: reason?.message || "Unknown error" })),
  ]);

  let claude;
  if (!claudeToken) {
    claude = { configured: false };
  } else if (!claudeResult || claudeResult.status === "rejected") {
    claude = { configured: true, error: claudeResult?.reason?.message || "Unknown error" };
  } else {
    claude = {
      configured: true,
      error: null,
      five_hour: claudeResult.value.five_hour,
      seven_day: claudeResult.value.seven_day,
      seven_day_opus: claudeResult.value.seven_day_opus,
      extra_usage: claudeResult.value.extra_usage,
    };
  }

  let codex;
  if (!codexToken) {
    codex = { configured: false };
  } else if (!codexResult || codexResult.status === "rejected") {
    codex = { configured: true, error: codexResult?.reason?.message || "Unknown error" };
  } else {
    codex = {
      configured: true,
      error: null,
      primary_window: codexResult.value.primary_window,
      secondary_window: codexResult.value.secondary_window,
    };
  }

  const data = {
    fetched_at: new Date(nowMs).toISOString(),
    claude,
    codex,
    cursor,
    kimi,
    gemini,
    kiro,
    antigravity,
    copilot,
  };

  cache = { data, fetchedAt: nowMs };
  return data;
}

function resetUsageLimitsCache() {
  cache = { data: null, fetchedAt: 0 };
}

module.exports = {
  getUsageLimits,
  resetUsageLimitsCache,
  extractGeminiOauthClientCredentials,
  loadKimiCredentials,
  normalizeCursorUsageSummary,
  normalizeGeminiQuotaResponse,
  normalizeKimiUsageResponse,
  parseKiroUsageOutput,
  normalizeAntigravityResponse,
  parseListeningPorts,
  detectAntigravityProcess,
  fetchCopilotLimits,
  readCopilotOauthToken,
  describeCopilotOtelStatus,
};
