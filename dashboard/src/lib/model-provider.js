// Model name -> provider mark. The ranking groups identical model names across
// tools, so this is deliberately a display-only hint rather than a data key.
const MODEL_PROVIDERS = [
  [/claude|fable|opus|sonnet|haiku/, "CLAUDE"],
  [/gpt|codex|o3|o4/, "CODEX"],
  [/gemini/, "GEMINI"],
  [/composer|cursor/, "CURSOR"],
  [/kimi|\bk3\b/, "KIMI"],
  [/mimo/, "MIMO"],
  [/copilot/, "COPILOT"],
  [/kiro/, "KIRO"],
  [/grok/, "GROK"],
  [/deepseek/, "DEEPSEEK"],
  [/glm/, "ZCODE"],
  [/hy3/, "WORKBUDDY"],
  [/minimax/, "MINIMAX"],
];

export function inferModelProvider(name) {
  const normalized = String(name || "").toLowerCase();
  const hit = MODEL_PROVIDERS.find(([pattern]) => pattern.test(normalized));
  return hit ? hit[1] : "";
}
