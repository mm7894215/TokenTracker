import { getLocalApiAuthHeaders } from "./local-api-auth";

export const BUILTIN_PETS = [
  { id: "clawd", displayName: "Clawd", nameKey: "pet.character.clawd", spriteVersionNumber: 1, custom: false },
  { id: "sprout", displayName: "Sprout", nameKey: "pet.character.sprout", spriteVersionNumber: 1, custom: false, assetUrl: "/pets/sprout/spritesheet.webp" },
  { id: "byte", displayName: "Byte", nameKey: "pet.character.byte", spriteVersionNumber: 1, custom: false, assetUrl: "/pets/byte/spritesheet.webp" },
  { id: "ember", displayName: "Ember", nameKey: "pet.character.ember", spriteVersionNumber: 1, custom: false, assetUrl: "/pets/ember/spritesheet.webp" },
];

async function payload(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Pet request failed with HTTP ${response.status}`);
  }
  return data;
}

export async function listPets() {
  const response = await fetch("/functions/tokentracker-pets", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await payload(response);
  return [...BUILTIN_PETS, ...(Array.isArray(data.pets) ? data.pets : [])];
}

async function mutate(body) {
  const auth = await getLocalApiAuthHeaders();
  return payload(await fetch("/functions/tokentracker-pets", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    cache: "no-store",
    body: JSON.stringify(body),
  }));
}

export function installPetFromUrl(url) {
  return mutate({ action: "install_url", url });
}

export async function importPetPackage(file) {
  const auth = await getLocalApiAuthHeaders();
  return payload(await fetch("/api/pets/import", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/zip", ...auth },
    cache: "no-store",
    body: file,
  }));
}

export function removePet(id) {
  return mutate({ action: "remove", id });
}

export async function listCodexImportable() {
  const response = await fetch("/functions/tokentracker-pets?scope=codex", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await payload(response);
  return {
    importable: Array.isArray(data.importable) ? data.importable : [],
    codexDetected: data.codexDetected === true,
  };
}

export function importCodexPets(ids) {
  return mutate({ action: "import_codex", ids });
}
