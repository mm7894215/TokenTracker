import { copy } from "./copy";

/** Canonical usage-limits provider ids (order defaults in useLimitsDisplayPrefs). */
export const LIMIT_PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "kimi",
  "kiro",
  "grok",
  "copilot",
  "antigravity",
];

/** Keys for ProviderIcon — mono logos use inline SVG; colored logos use /brand-logos/. */
export const LIMIT_PROVIDER_ICON_KEYS = {
  claude: "CLAUDE",
  codex: "CODEX",
  cursor: "CURSOR",
  gemini: "GEMINI",
  kimi: "KIMI",
  kiro: "KIRO",
  grok: "GROK",
  copilot: "COPILOT",
  antigravity: "ANTIGRAVITY",
};

export function limitProviderIconKey(id) {
  return LIMIT_PROVIDER_ICON_KEYS[id] || null;
}

export function limitProviderName(id) {
  switch (id) {
    case "claude":
      return copy("limits.provider.claude");
    case "codex":
      return copy("limits.provider.codex");
    case "cursor":
      return copy("limits.provider.cursor");
    case "gemini":
      return copy("limits.provider.gemini");
    case "kimi":
      return copy("limits.provider.kimi");
    case "kiro":
      return copy("limits.provider.kiro");
    case "grok":
      return copy("limits.provider.grok");
    case "copilot":
      return copy("limits.provider.copilot");
    case "antigravity":
      return copy("limits.provider.antigravity");
    default:
      return String(id || "");
  }
}