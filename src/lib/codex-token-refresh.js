const fs = require("node:fs");
const path = require("node:path");

// Public Codex OAuth client. Same id used by the official `codex` CLI. Aligned with
// steipete/CodexBar's CodexTokenRefresher.swift — neither is sensitive (it's a public client).
const REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// Match the official Codex CLI: when the access token exposes a JWT expiry, refresh only
// shortly before it expires. Fall back to last_refresh > 8 days for opaque/legacy tokens.
const REFRESH_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

function parseJwtExpirationMs(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch (_e) {
    return null;
  }
}

function isTokenStale(lastRefreshIso, nowMs = Date.now(), accessToken = null) {
  const expiresAtMs = parseJwtExpirationMs(accessToken);
  if (expiresAtMs !== null) {
    return expiresAtMs <= nowMs + ACCESS_TOKEN_REFRESH_WINDOW_MS;
  }
  if (!lastRefreshIso) return true;
  const ts = Date.parse(lastRefreshIso);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts > REFRESH_THRESHOLD_MS;
}

async function refreshCodexTokens({ refreshToken, fetchImpl = fetch }) {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    const err = new Error("Codex refresh skipped: no refresh_token in auth.json");
    err.code = "NO_REFRESH_TOKEN";
    throw err;
  }

  const res = await fetchImpl(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (res.status === 401) {
    let openaiErrorCode = null;
    try {
      const body = await res.json();
      openaiErrorCode =
        (body && typeof body.error === "object" && body.error.code) ||
        (typeof body?.error === "string" ? body.error : null) ||
        body?.code ||
        null;
    } catch (_e) {
      // Ignore parse failure — surface the generic reason.
    }
    const reason = String(openaiErrorCode || "").toLowerCase();
    let message = "Codex refresh token was rejected. Run `codex login` to re-authenticate.";
    if (reason === "refresh_token_expired") {
      message = "Codex refresh token expired. Run `codex login` to re-authenticate.";
    } else if (reason === "refresh_token_reused") {
      message =
        "Codex refresh token was already used, likely by another Codex process. " +
        "Run `codex login` to re-authenticate.";
    } else if (reason === "refresh_token_invalidated") {
      message = "Codex refresh token was revoked. Run `codex login` to re-authenticate.";
    }
    const err = new Error(message);
    err.code = "REFRESH_TOKEN_EXPIRED";
    err.openaiErrorCode = openaiErrorCode;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Codex token refresh failed: ${res.status}`);
    err.code = "REFRESH_HTTP_ERROR";
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    const err = new Error("Codex token refresh response missing access_token");
    err.code = "REFRESH_INVALID_RESPONSE";
    throw err;
  }

  return {
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : refreshToken,
    id_token: typeof body.id_token === "string" ? body.id_token : null,
  };
}

// Atomic write so a process kill mid-write doesn't corrupt auth.json (which would force the
// user to re-run `codex` login).
async function persistRefreshedAuth(authPath, currentAuth, newTokens) {
  const merged = {
    ...currentAuth,
    tokens: {
      ...(currentAuth.tokens || {}),
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token,
      id_token: newTokens.id_token || currentAuth?.tokens?.id_token || null,
    },
    last_refresh: new Date().toISOString(),
  };

  const tmp = `${authPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, authPath);
  return merged;
}

module.exports = {
  REFRESH_ENDPOINT,
  CODEX_CLIENT_ID,
  REFRESH_THRESHOLD_MS,
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  parseJwtExpirationMs,
  isTokenStale,
  refreshCodexTokens,
  persistRefreshedAuth,
};
