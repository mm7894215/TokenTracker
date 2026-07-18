import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "../../ui/foundation/LocaleProvider.jsx";
import { TokenFormatProvider } from "../../ui/foundation/TokenFormatProvider.jsx";
import { TOKEN_FORMAT_STORAGE_KEY } from "../../lib/token-format.js";
import { CommunityStatsModal } from "./CommunityStatsModal.jsx";

// The zoom modal pulls in use-trend-data (a .ts hook imported with a .js
// specifier) that vitest cannot resolve; the modal never renders it anyway.
vi.mock("../../ui/dashboard/components/TrendMonitorZoomModal", () => ({
  TrendMonitorZoomModal: () => null,
}));

vi.mock("motion/react", () => {
  const strip = ({ layoutId: _l, transition: _t, initial: _i, animate: _a, ...props }) => props;
  return {
    motion: {
      div: (props) => <div {...strip(props)} />,
      span: (props) => <span {...strip(props)} />,
    },
    useReducedMotion: () => true,
  };
});

const STATS = {
  status: "ready",
  tokenFloor: 1_000_000_000,
  totalEntries: 20,
  activeDevelopersTotal: 20,
  activeDevelopers30d: 12,
  tokens30d: 300_000_000,
  tokenGrowthPct: 5.2,
  developerGrowthPct: -1.4,
  generatedAt: "2026-07-18T08:00:00.000Z",
  providers: [
    { name: "codex", tokens: 600_000_000, developers: 15, share: 60 },
    { name: "claude", tokens: 300_000_000, developers: 12, share: 30 },
    { name: "cursor", tokens: 100_000_000, developers: 8, share: 10 },
  ],
  dailyGrowth: [],
  tokenMix: [],
  userDistribution: [],
  platforms: [],
  topModels: [],
};

describe("CommunityStatsModal", () => {
  it("keeps tabs in the single-column header and renders providers in rank order", async () => {
    const user = userEvent.setup();
    render(<CommunityStatsModal isOpen onClose={vi.fn()} communityStats={STATS} />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    const providers = screen.getByRole("tab", { name: "Providers" });
    const header = screen.getByTestId("community-metrics-header");
    screen.getByTestId("community-metrics-content");
    expect(screen.queryByTestId("community-metrics-sidebar")).toBeNull();
    expect(header).toContainElement(screen.getByRole("tablist"));
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(overview.querySelector("span")).toHaveClass("h-0.5", "bg-oai-black");

    await act(async () => {
      await user.click(providers);
    });
    expect(providers).toHaveAttribute("aria-selected", "true");
    expect(overview).toHaveAttribute("aria-selected", "false");

    const rankedRows = Array.from(document.querySelectorAll("[data-provider-rank]"));
    expect(rankedRows.map((row) => row.getAttribute("data-provider-name")))
      .toEqual(["codex", "claude", "cursor"]);
    expect(rankedRows.map((row) => row.getAttribute("data-provider-rank")))
      .toEqual(["1", "2", "3"]);
  });

  it("caps the provider and model rankings at ten rows", async () => {
    const user = userEvent.setup();
    const manyRows = Array.from({ length: 14 }, (_, i) => ({
      name: `provider-${i + 1}`,
      tokens: (14 - i) * 1_000_000,
      developers: 14 - i,
      share: 14 - i,
    }));
    render(
      <CommunityStatsModal
        isOpen
        onClose={vi.fn()}
        communityStats={{
          ...STATS,
          providers: manyRows,
          topModels: manyRows.map((row) => ({ name: `model-${row.name}`, tokens: row.tokens, share: row.share })),
        }}
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("tab", { name: "Providers" }));
    });
    expect(document.querySelectorAll("[data-provider-rank]")).toHaveLength(10);

    await act(async () => {
      await user.click(screen.getByRole("tab", { name: "Models" }));
    });
    expect(document.querySelectorAll("[data-model-rank]")).toHaveLength(10);
  });

  it("renders relative progress bars for model rankings", async () => {
    const user = userEvent.setup();
    render(
      <CommunityStatsModal
        isOpen
        onClose={vi.fn()}
        communityStats={{
          ...STATS,
          topModels: [
            { name: "gpt-5", tokens: 500_000_000, share: 50 },
            { name: "claude-opus", tokens: 250_000_000, share: 25 },
          ],
        }}
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("tab", { name: "Models" }));
    });

    const progressBars = screen.getAllByRole("progressbar");
    expect(progressBars).toHaveLength(2);
    expect(progressBars[0]).toHaveStyle({ width: "100%" });
    expect(progressBars[1]).toHaveStyle({ width: "50%" });
    expect(progressBars[0]).toHaveAttribute("aria-valuenow", "50");
  });

  it("keeps every headline number compact when the global preference is full", () => {
    window.localStorage.setItem(TOKEN_FORMAT_STORAGE_KEY, "full");
    const compactStats = {
      ...STATS,
      activeDevelopersTotal: 12_345,
    };

    render(
      <LocaleProvider>
        <TokenFormatProvider>
          <CommunityStatsModal isOpen onClose={vi.fn()} communityStats={compactStats} />
        </TokenFormatProvider>
      </LocaleProvider>,
    );

    expect(screen.getByText("1B")).toBeInTheDocument();
    expect(screen.getByText("300M")).toBeInTheDocument();
    expect(screen.getByText("12.3K")).toBeInTheDocument();
    expect(screen.queryByText("1,000,000,000")).not.toBeInTheDocument();
  });
});
