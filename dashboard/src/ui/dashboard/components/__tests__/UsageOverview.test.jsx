import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageOverview } from "../UsageOverview.jsx";

const breakdownProps = [];

vi.mock("../ContextBreakdownPanel.jsx", () => ({
  ContextBreakdownPanel: (props) => {
    breakdownProps.push(props);
    return <div data-testid="context-breakdown">{`${props.source}:${props.from}:${props.to}`}</div>;
  },
}));

vi.mock("../../../../hooks/useTheme.js", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

describe("UsageOverview", () => {
  it("renders configurable auto-refresh intervals and reports the selected value", async () => {
    const user = userEvent.setup();
    const onAutoRefreshIntervalChange = vi.fn();

    render(
      <UsageOverview
        period="day"
        periods={["day"]}
        summaryLabel="Total"
        summaryValue="123"
        summaryUpdatedAtLabel="Updated Jun 5, 2026, 03:55:00 GMT+7"
        autoRefreshOptions={[
          { value: 0, labelKey: "usage.auto_refresh.off" },
          { value: 30000, labelKey: "usage.auto_refresh.30s" },
          { value: 60000, labelKey: "usage.auto_refresh.60s" },
          { value: 120000, labelKey: "usage.auto_refresh.120s" },
        ]}
        autoRefreshIntervalMs={30000}
        onAutoRefreshIntervalChange={onAutoRefreshIntervalChange}
      />,
    );

    const select = screen.getByRole("combobox", { name: "Auto refresh interval" });
    expect(select).toHaveValue("30000");
    expect(screen.getByText("Updated Jun 5, 2026, 03:55:00 GMT+7")).toBeInTheDocument();

    await user.selectOptions(select, "120000");

    expect(onAutoRefreshIntervalChange).toHaveBeenCalledWith("120000");
  });

  it("passes the overview usage range to Codex context breakdown", async () => {
    breakdownProps.length = 0;
    const user = userEvent.setup();

    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "100.0",
            usage: 123,
            usd: 0,
            models: [{ id: "gpt-5.5", name: "gpt-5.5", share: 100, usage: 123, cost: 0 }],
          },
        ]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /CODEX/i }));
    });

    expect(screen.getByTestId("context-breakdown")).toHaveTextContent(
      "codex:2026-05-01:2026-05-31",
    );
    expect(breakdownProps[0]).toMatchObject({
      source: "codex",
      from: "2026-05-01",
      to: "2026-05-31",
      referenceTotalTokens: 123,
    });
  });
});
