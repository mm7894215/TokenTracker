const SPECIAL_PROVIDER_NAMES = {
  anythingllm: "AnythingLLM",
  pianthropic: "Pi · Anthropic",
  pigithubcopilot: "Pi · GitHub Copilot",
  picopilot: "Pi · Copilot",
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

  const specialName = SPECIAL_PROVIDER_NAMES[normalizedProviderKey(raw)];
  if (specialName) return specialName;

  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
