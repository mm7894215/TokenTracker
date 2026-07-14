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
  it("renders AnythingLLM with its official name, icon, and stable accent", () => {
    const { container } = render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[
          {
            source: "anythingllm",
            label: "anythingllm",
            totalPercent: "100.0",
            usage: 123,
            usd: 0,
            models: [{ id: "deepseek-v4", name: "deepseek-v4", share: 100, usage: 123, cost: 0 }],
          },
        ]}
        from="2026-07-01"
        to="2026-07-31"
      />,
    );

    expect(screen.getByText("AnythingLLM")).toBeTruthy();
    expect(container.querySelector('img[src="/brand-logos/anythingllm.svg"]')).toHaveClass(
      "brightness-0",
      "dark:brightness-100",
    );
    expect(container.querySelector('[title="AnythingLLM: 100.0%"]')).toHaveStyle({
      backgroundColor: "var(--provider-anythingllm)",
    });
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

  it("toggles the summary number format when the hero total is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="1.23B"
        summaryFullValue="1,234,567,890"
        onToggleSummaryFormat={onToggle}
        fleetData={[]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    const toggle = screen.getByRole("button", { name: /toggle compact number format/i });
    expect(toggle).toHaveAttribute("title", "1,234,567,890");
    // The compact value renders intact (incl. its unit-letter suffix), not
    // truncated.
    expect(toggle).toHaveTextContent("1.23B");

    await act(async () => {
      await user.click(toggle);
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders the hero total as plain text when no toggle handler is provided", () => {
    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="1,234,567,890"
        fleetData={[]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /toggle compact number format/i }),
    ).toBeNull();
  });
});
