// Human-facing label for a cloud device row.
//
// Every browser / WebView registers under the same auto-generated name
// `Token Tracker (dashboard) #<machineId8>` (see src/lib/cloud-sync.ts), so the
// raw device_name is unreadable when several devices are listed side by side.
// This derives a cleaner default — `<platform> · <shortid>` — from that auto
// pattern, while leaving any user-chosen name (set via the rename endpoint)
// untouched. Returns null when there is nothing usable, so callers can fall
// back to their own "unnamed device" copy.

const AUTO_NAME_RE = /^Token Tracker \(dashboard\)(?: #([0-9a-fA-F]+))?$/;

function platformLabel(platform) {
  const p = String(platform || "").toLowerCase();
  if (/iphone|ipad|ios/.test(p)) return "iOS";
  if (/android/.test(p)) return "Android";
  if (/mac|darwin/.test(p)) return "Mac";
  if (/win/.test(p)) return "Windows";
  if (/linux/.test(p)) return "Linux";
  return "Web";
}

// `device` is a row from tokentracker-account-devices: { id, device_name, platform }.
export function formatDeviceLabel(device) {
  if (!device) return null;
  const raw = typeof device.device_name === "string" ? device.device_name.trim() : "";
  const auto = raw.match(AUTO_NAME_RE);
  if (!auto) return raw || null; // user-renamed (or some other custom name) — show verbatim
  // Stable short id: prefer the machine-id suffix already baked into the auto
  // name (consistent across this machine's sessions); else fall back to the
  // device UUID prefix so the canonical, suffix-less row still disambiguates.
  const shortId = (auto[1] || String(device.id || "")).slice(0, 8).toLowerCase();
  return shortId ? `${platformLabel(device.platform)} · ${shortId}` : platformLabel(device.platform);
}
