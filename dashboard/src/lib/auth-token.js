export function normalizeAccessToken(token) {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getAccessTokenExpiryMs(token) {
  const normalized = normalizeAccessToken(token);
  if (!normalized) return null;
  const parts = normalized.split(".");
  if (parts.length < 2) return null;
  const payloadPart = parts[1];
  try {
    const padded = payloadPart
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(payloadPart.length + ((4 - (payloadPart.length % 4)) % 4), "=");
    const decoded =
      typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(decoded);
    const exp = payload?.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
    return Math.floor(exp * 1000);
  } catch {
    return null;
  }
}

export function isValidJwtShape(token) {
  const normalized = normalizeAccessToken(token);
  if (!normalized) return false;
  const parts = normalized.split(".");
  if (parts.length !== 3) return false;
  try {
    for (let i = 0; i < 2; i++) {
      const part = parts[i];
      if (!/^[A-Za-z0-9_-]+$/.test(part)) return false;
      const padded = part
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(part.length + ((4 - (part.length % 4)) % 4), "=");
      const decoded =
        typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8");
      if (i === 1) JSON.parse(decoded);
    }
    return true;
  } catch {
    return false;
  }
}

export function isLikelyExpiredAccessToken(token, skewMs = 30_000) {
  const expiryMs = getAccessTokenExpiryMs(token);
  if (!expiryMs) return false;
  return expiryMs <= Date.now() + Math.max(0, Number(skewMs) || 0);
}

export async function resolveAuthAccessToken(auth) {
  if (!auth) return null;
  if (typeof auth === "string") return normalizeAccessToken(auth);
  if (typeof auth === "function") {
    try {
      const token = await auth();
      return normalizeAccessToken(token);
    } catch {
      return null;
    }
  }
  if (typeof auth === "object") {
    if (typeof auth.getAccessToken === "function") {
      try {
        const token = await auth.getAccessToken();
        const normalized = normalizeAccessToken(token);
        if (normalized) return normalized;
      } catch {
        // fall back to object.accessToken when available
      }
      return normalizeAccessToken(auth.accessToken);
    }
    // Keep readiness semantics consistent with isAccessTokenReady:
    // object-only providers (without getAccessToken) are treated as not ready.
    return null;
  }
  return normalizeAccessToken(auth);
}

/**
 * InsForge 等云端接口：localhost 上 `isAccessTokenReady` 可能已为 true，但 `getAccessToken()`
 * 首帧尚未就绪。短重试避免无 Authorization 的 401。
 */
export async function resolveAuthAccessTokenWithRetry(auth, options = {}) {
  const maxAttempts = Math.max(1, Math.min(12, Math.floor(Number(options.maxAttempts) || 8)));
  const baseDelayMs = Math.max(20, Math.floor(Number(options.baseDelayMs) || 50));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t = await resolveAuthAccessToken(auth);
    if (t) return t;
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  return null;
}

export function isAccessTokenReady(token) {
  // 本地开发模式不需要真实 token
  if (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return true;
  }
  if (typeof token === "function") return true;
  if (token && typeof token === "object") {
    if (typeof token.getAccessToken === "function") return true;
  }
  return Boolean(normalizeAccessToken(token));
}
