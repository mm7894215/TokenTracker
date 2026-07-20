import { render, screen } from "@testing-library/react";
import { setCopyLocale } from "../../../../lib/copy";
import { TokenFormatContext } from "../../../foundation/TokenFormatProvider.jsx";
import { StatsPanel } from "../StatsPanel.jsx";

function renderPanel(props = {}) {
  return render(
    <StatsPanel
      startDate="2026-03-01"
      streakDays={12}
      rolling={{
        last_7d: { totals: { billable_total_tokens: 12345 } },
        last_30d: {
          totals: { billable_total_tokens: 67890, conversation_count: 999 },
          avg_per_active_day: 2222,
        },
      }}
      topModels={[]}
      {...props}
    />,
  );
}

it("shows current-period conversations instead of fixed rolling 30-day conversations", () => {
  renderPanel({ period: "month", periodConversations: 42 });

  expect(screen.getByText("42")).toBeInTheDocument();
  expect(screen.getByText("convs")).toBeInTheDocument();
  expect(screen.queryByText("999")).not.toBeInTheDocument();
});

it("uses the same compact conversations label across periods", () => {
  renderPanel({ period: "day", periodConversations: 7 });

  expect(screen.getByText("7")).toBeInTheDocument();
  expect(screen.getByText("convs")).toBeInTheDocument();
  expect(screen.queryByText("today")).not.toBeInTheDocument();
});

it("keeps rolling card values compact when the global token format is full", () => {
  render(
    <TokenFormatContext.Provider
      value={{
        mode: "full",
        setMode: () => {},
        formatTokens: (value) => Number(value).toLocaleString("en-US"),
        formatTokensTooltip: (value) => Number(value).toLocaleString("en-US"),
      }}
    >
      <StatsPanel
        startDate="2026-03-01"
        streakDays={12}
        periodConversations={30_500}
        rolling={{
          last_7d: { totals: { billable_total_tokens: 2_800_000_000 } },
          last_30d: {
            totals: { billable_total_tokens: 8_500_000_000 },
            avg_per_active_day: 303_500_000,
          },
        }}
      />
    </TokenFormatContext.Provider>,
  );

  expect(screen.getByText("2.8B")).toBeInTheDocument();
  expect(screen.getByText("8.5B")).toBeInTheDocument();
  expect(screen.getByText("303.5M")).toBeInTheDocument();
  expect(screen.getByText("30.5K")).toBeInTheDocument();
  expect(screen.queryByText("2,800,000,000")).not.toBeInTheDocument();
});

it("keeps the rolling stats readable in a narrow desktop sidebar", () => {
  const { container } = renderPanel({ periodConversations: 42 });
  const grid = container.querySelector(".grid.grid-cols-2");

  expect(grid).toHaveClass("lg:grid-cols-2");
  expect(grid).toHaveClass("xl:grid-cols-4");
  expect(grid?.children).toHaveLength(4);
  for (const tile of Array.from(grid?.children || [])) {
    expect(tile).toHaveClass("min-w-0");
  }
});

it("localizes compact rolling stats labels", () => {
  const cases = [
    ["en", ["7d", "30d", "avg", "convs"]],
    ["zh-CN", ["7 天", "30 天", "平均", "对话"]],
    ["zh-TW", ["7 天", "30 天", "平均", "對話"]],
    ["ja", ["7日", "30日", "平均", "会話"]],
    ["ko", ["7일", "30일", "평균", "대화"]],
  ];

  for (const [locale, labels] of cases) {
    setCopyLocale(locale);
    const view = renderPanel({ periodConversations: 42 });
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    view.unmount();
  }
  setCopyLocale("en");
});
