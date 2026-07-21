type AnyRecord = Record<string, any>;

export interface SkillInventoryDeviceSource {
  id: string;
  name: string;
  platform: string | null;
  scannedAt: string | null;
}

export interface SkillInventoryMetadata {
  key: string;
  name: string;
  directory: string;
  targets: string[];
  managed: boolean;
  readOnly: boolean;
  scope: "managed" | "local" | "system" | "plugin";
  sourceName?: string;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanRelativePath(value: unknown): string {
  const raw = cleanString(value).replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const parts = raw.replace(/\/+$/g, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function cleanStableKey(value: unknown): string {
  const key = cleanString(value).replace(/\\/g, "/");
  // Generated keys may contain relative plugin/repository paths, but never a
  // URI or an absolute Windows/Unix path. Reject those before the request is
  // sent so private local locations do not even cross the network boundary.
  if (!key || key.startsWith("/") || key.includes(":/") || /[A-Za-z]:\//.test(key)) return "";
  return key;
}

export function skillInventoryKey(skill: AnyRecord): string {
  return cleanString(skill?.key) || cleanString(skill?.id) || `local:${cleanString(skill?.directory)}`;
}

// Privacy boundary for cloud sync. Keep this allow-list deliberately small:
// no description, SKILL.md body, readme URL, prompt text, or absolute target
// paths can cross the device boundary through this projection.
export function buildSkillInventoryMetadata(skills: AnyRecord[]): SkillInventoryMetadata[] {
  return (Array.isArray(skills) ? skills : [])
    .map((skill): SkillInventoryMetadata | null => {
      const directory = cleanRelativePath(skill?.directory);
      const key = cleanStableKey(skillInventoryKey(skill));
      if (!key || !directory) return null;
      const scope = skill?.scope === "system" || skill?.scope === "plugin"
        ? skill.scope
        : skill?.managed
          ? "managed"
          : "local";
      const sourceName = cleanRelativePath(skill?.sourceName);
      return {
        key,
        name: cleanString(skill?.name) || directory.split("/").pop() || "Skill",
        directory,
        targets: Array.isArray(skill?.targets)
          ? [...new Set(skill.targets.map(cleanString).filter(Boolean))]
          : [],
        managed: skill?.managed === true,
        readOnly: skill?.readOnly === true,
        scope,
        ...(sourceName ? { sourceName } : {}),
      };
    })
    .filter((skill): skill is SkillInventoryMetadata => Boolean(skill));
}

function deviceSource(device: AnyRecord): SkillInventoryDeviceSource {
  return {
    id: cleanString(device?.id),
    name: cleanString(device?.device_name) || cleanString(device?.id),
    platform: cleanString(device?.platform) || null,
    scannedAt: cleanString(device?.scanned_at) || null,
  };
}

function addDeviceSource(skill: AnyRecord, source: SkillInventoryDeviceSource) {
  const existing = Array.isArray(skill.deviceSources) ? skill.deviceSources : [];
  if (existing.some((item: SkillInventoryDeviceSource) => item.id === source.id)) return skill;
  return { ...skill, deviceSources: [...existing, source] };
}

/**
 * Merge other-device inventory into the local list.
 *
 * A matching local skill stays fully manageable and merely gains device-source
 * labels. A skill seen only on another device becomes a read-only row, so a
 * desktop can never delete or retarget another machine's filesystem.
 */
export function mergeSkillInventories(
  localSkills: AnyRecord[],
  cloudPayload: AnyRecord,
  currentDeviceId: string,
): AnyRecord[] {
  const merged = (Array.isArray(localSkills) ? localSkills : []).map((skill) => ({ ...skill }));
  const byKey = new Map<string, number>();
  merged.forEach((skill, index) => byKey.set(skillInventoryKey(skill).toLowerCase(), index));

  for (const device of Array.isArray(cloudPayload?.devices) ? cloudPayload.devices : []) {
    const source = deviceSource(device);
    if (!source.id || source.id === currentDeviceId) continue;
    for (const remote of Array.isArray(device?.skills) ? device.skills : []) {
      const key = skillInventoryKey(remote);
      const directory = cleanString(remote?.directory);
      if (!key || !directory) continue;
      const normalizedKey = key.toLowerCase();
      const existingIndex = byKey.get(normalizedKey);
      if (existingIndex != null) {
        const existing = merged[existingIndex];
        const targets = [...new Set([...(existing.targets || []), ...(remote.targets || [])])];
        merged[existingIndex] = addDeviceSource({ ...existing, targets }, source);
        continue;
      }

      const targets = Array.isArray(remote.targets) ? [...new Set(remote.targets.map(cleanString).filter(Boolean))] : [];
      const targetStates = Object.fromEntries(targets.map((target) => [target, "synced"]));
      const entry = addDeviceSource({
        id: `remote:${encodeURIComponent(key)}`,
        key,
        name: cleanString(remote.name) || directory.split(/[\\/]/).pop() || "Skill",
        directory,
        description: "",
        targets,
        targetStates,
        managed: false,
        readOnly: true,
        inventoryOnly: true,
        remote: true,
        scope: cleanString(remote.scope) || "local",
        sourceName: cleanString(remote.sourceName) || null,
      }, source);
      byKey.set(normalizedKey, merged.length);
      merged.push(entry);
    }
  }

  return merged.sort((a, b) => {
    const byName = String(a.name || a.directory).localeCompare(String(b.name || b.directory));
    return byName || String(a.id || a.key).localeCompare(String(b.id || b.key));
  });
}
