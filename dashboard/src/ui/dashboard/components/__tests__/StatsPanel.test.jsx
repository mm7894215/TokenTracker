import { render, screen } from "@testing-library/react";
import { StatsPanel } from "../StatsPanel.jsx";

function renderPanel(props = {}) {
  return render(
    <StatsPanel
      rankLabel="2026-03-01"
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
  expect(screen.getByText("month")).toBeInTheDocument();
  expect(screen.queryByText("999")).not.toBeInTheDocument();
});

it("updates the conversations badge label for day period", () => {
  renderPanel({ period: "day", periodConversations: 7 });

  expect(screen.getByText("7")).toBeInTheDocument();
  expect(screen.getByText("today")).toBeInTheDocument();
});
