import { describe, expect, it } from "vitest";
import { buildAllModels, buildFleetData } from "./model-breakdown";

describe("buildFleetData", () => {
  it("keeps two decimal places for small provider percentages", () => {
    const fleet = buildFleetData({
      sources: [
        {
          source: "claude",
          totals: { billable_total_tokens: 999_600 },
          models: [{ model_id: "claude-sonnet", totals: { billable_total_tokens: 999_600 } }],
        },
        {
          source: "antigravity",
          totals: { billable_total_tokens: 400 },
          models: [{ model_id: "gemini-pro", totals: { billable_total_tokens: 400 } }],
        },
        {
          source: "grok",
          totals: { billable_total_tokens: 1 },
          models: [{ model_id: "grok-code", totals: { billable_total_tokens: 1 } }],
        },
      ],
    });

    expect(fleet.map(({ source, totalPercent }) => [source, totalPercent])).toEqual([
      ["claude", "99.96"],
      ["antigravity", "0.04"],
      ["grok", "0.00"],
    ]);
    expect(fleet[2].totalPercentValue).toBeGreaterThan(0);
    expect(fleet[2].totalPercentValue).toBeLessThan(0.01);
  });
});

describe("buildAllModels", () => {
  it("combines the same model across tools and ranks every personal model", () => {
    const models = buildAllModels([
      {
        label: "CODEX",
        models: [
          { id: "gpt-5.6", name: "GPT-5.6", usage: 70, cost: 0.7 },
          { id: "gpt-5.5", name: "gpt-5.5", usage: 20, cost: 0.2 },
        ],
      },
      {
        label: "CURSOR",
        models: [
          { id: "gpt-5.6", name: "gpt-5.6", usage: 30, cost: 0.3 },
          { id: "claude", name: "claude-sonnet", usage: 80, cost: null },
        ],
      },
    ]);

    expect(models).toEqual([
      { id: "gpt-5.6", name: "GPT-5.6", usage: 100, cost: 1, share: 50 },
      { id: "claude-sonnet", name: "claude-sonnet", usage: 80, cost: null, share: 40 },
      { id: "gpt-5.5", name: "gpt-5.5", usage: 20, cost: 0.2, share: 10 },
    ]);
  });
});
