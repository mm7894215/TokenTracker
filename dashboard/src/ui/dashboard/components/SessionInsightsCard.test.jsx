import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE, ZH_CN_LOCALE } from "../../../lib/locale";
import { getContextHealth, getSessionInsights } from "../../../lib/api";
import { SessionInsightsCard } from "./SessionInsightsCard.jsx";

const preference = vi.hoisted(() => ({ enabled: true }));

vi.mock("../../../lib/api", () => ({
  getContextHealth: vi.fn(),
  getSessionInsights: vi.fn(),
}));

vi.mock("../../../hooks/useTokenFormat.js", () => ({
  useTokenFormat: () => ({
    formatTokens: (value) => {
      if (value == null) return "-";
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
      return String(value);
    },
  }),
}));

vi.mock("../../../hooks/use-session-efficiency-pref.js", () => ({
  useSessionEfficiencyPref: () => ({ enabled: preference.enabled }),
}));

const data = {
  available: true,
  session_count: 70,
  summary: {
    sessions: 70,
    edit_sessions: 39,
    first_pass_sessions: 9,
    edit_session_rate: 39 / 70,
    first_pass_rate: 9 / 39,
    edit_turns: 170,
    cost_per_edit: 4.776,
  },
  by_model: [
    {
      model: "gpt-5.6-sol",
      sessions: 70,
      edit_sessions: 39,
      first_pass_rate: 9 / 39,
      edit_turns: 170,
      tokens_per_edit: 6_613_085,
    },
    { model: "unknown", sessions: 12, edit_sessions: 0, edit_turns: 0, tokens_per_edit: null },
    { model: "openai", sessions: 180, edit_sessions: 0, edit_turns: 0, tokens_per_edit: null },
    { model: "gpt-5.4", sessions: 20, edit_sessions: 0, edit_turns: 0, tokens_per_edit: null },
  ],
  subagents: [{ name: "spawn_agent", calls: 7 }],
};

describe("SessionInsightsCard", () => {
  afterEach(() => {
    preference.enabled = true;
    setCopyLocale(EN_LOCALE);
    vi.clearAllMocks();
  });

  it("does not fetch or reserve card space while the Beta feature is disabled", () => {
    preference.enabled = false;

    const { container } = render(<SessionInsightsCard from="2026-07-01" to="2026-07-31" />);

    expect(container).toBeEmptyDOMElement();
    expect(getSessionInsights).not.toHaveBeenCalled();
    expect(getContextHealth).not.toHaveBeenCalled();
  });

  it("renders observed Codex edit coverage instead of empty placeholders", async () => {
    getSessionInsights.mockResolvedValue(data);
    getContextHealth.mockResolvedValue({ estimated_fixed_tokens: 155_300 });

    render(<SessionInsightsCard from="2026-07-01" to="2026-07-31" />);

    const model = await screen.findByText("gpt-5.6-sol");
    const row = model.closest("tr");
    expect(within(row).getByText("39 / 70")).toBeInTheDocument();
    expect(within(row).getByText("23%")).toBeInTheDocument();
    expect(within(row).getByText("6.6M")).toBeInTheDocument();
    expect(screen.queryByText("unknown")).not.toBeInTheDocument();
    expect(screen.queryByText("openai")).not.toBeInTheDocument();
    expect(screen.queryByText("gpt-5.4")).not.toBeInTheDocument();
    expect(screen.getByText("spawn_agent · 7")).toBeInTheDocument();
    expect(screen.getByText("BETA")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Edit = a user turn containing an observed edit tool");
  });

  it("localizes the redesigned metric contract", async () => {
    setCopyLocale(ZH_CN_LOCALE);
    getSessionInsights.mockResolvedValue(data);
    getContextHealth.mockResolvedValue({ estimated_fixed_tokens: 155_300 });

    render(<SessionInsightsCard from="2026-07-01" to="2026-07-31" />);

    expect(await screen.findByRole("heading", { name: "会话效率" })).toBeInTheDocument();
    expect(screen.getAllByText("编辑会话").length).toBeGreaterThan(0);
    expect(screen.getAllByText("一次完成").length).toBeGreaterThan(0);
    expect(screen.getByRole("tooltip")).toHaveTextContent("编辑 =");
  });
});
