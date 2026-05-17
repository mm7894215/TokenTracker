export function pickDisplayName(user) {
  if (!user || typeof user !== "object") return "";
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const value = meta.full_name || meta.name || prof.name || meta.user_name || meta.preferred_username;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof user.email === "string" && user.email.includes("@")) {
    return user.email.split("@")[0].trim() || user.email.trim();
  }
  return typeof user.email === "string" ? user.email.trim() : "";
}

export function pickEmail(user) {
  if (!user || typeof user !== "object") return "";
  return typeof user.email === "string" ? user.email.trim() : "";
}

export function normalizeGithubProfileUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const handleMatch = raw.match(/^@?([A-Za-z0-9][A-Za-z0-9-]{0,38})$/);
  const urlMatch = raw.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/?$/i);
  const handle = handleMatch?.[1] || urlMatch?.[1];
  return handle ? `https://github.com/${handle}` : null;
}
