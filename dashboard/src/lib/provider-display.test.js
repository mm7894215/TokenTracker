import { describe, expect, it } from "vitest";
import { formatProviderDisplayName } from "./provider-display.js";

describe("formatProviderDisplayName", () => {
  it.each(["anythingllm", "AnythingLLM", "anything-llm", "anything_llm"])(
    "normalizes %s to the official AnythingLLM casing",
    (value) => {
      expect(formatProviderDisplayName(value)).toBe("AnythingLLM");
    },
  );

  it("preserves the existing generic capitalization fallback", () => {
    expect(formatProviderDisplayName("cursor")).toBe("Cursor");
    expect(formatProviderDisplayName("CODEX")).toBe("CODEX");
    expect(formatProviderDisplayName("")).toBe("");
  });

  it("gives Pi routed providers distinct readable names", () => {
    expect(formatProviderDisplayName("pi-anthropic")).toBe("Pi · Anthropic");
    expect(formatProviderDisplayName("PI-GITHUB-COPILOT")).toBe("Pi · GitHub Copilot");
  });
});
