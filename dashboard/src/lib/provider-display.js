import { copy } from "./copy";

const SPECIAL_PROVIDER_NAMES = {
  anythingllm: "AnythingLLM",
  claudescience: "Claude Science",
  pianthropic: "Pi · Anthropic",
  pigithubcopilot: "Pi · GitHub Copilot",
  picopilot: "Pi · Copilot",
};

const SPECIAL_PROVIDER_COPY_KEYS = {
  omp: "provider.display.omp",
};

function normalizedProviderKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function formatProviderDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const normalized = normalizedProviderKey(raw);
  const specialCopyKey = SPECIAL_PROVIDER_COPY_KEYS[normalized];
  if (specialCopyKey) return copy(specialCopyKey);

  const specialName = SPECIAL_PROVIDER_NAMES[normalized];
  if (specialName) return specialName;

  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
