function parseVersion(value) {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(String(value || "").trim());
  return match ? match[1].split(".").map(Number) : null;
}

export function isNewerVersion(currentVersion, latestVersion) {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) return false;

  const length = Math.max(current.length, latest.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = current[index] || 0;
    const latestPart = latest[index] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}
