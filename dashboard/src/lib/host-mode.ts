/**
 * Distinguishes local CLI / NPX / embedded-app usage (loopback) from a public deployment hostname.
 * Used for default route (dashboard vs landing) and Home link targets.
 */
function isLocalDashboardHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Path to open the dashboard from marketing: loopback keeps `/` as dashboard; public deploy uses `/dashboard` while `/` stays landing. */
export function getDashboardEntryPath(): string {
  return isLocalDashboardHost() ? "/" : "/dashboard";
}
