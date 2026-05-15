import { render } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { UsagePanel } from "../UsagePanel.jsx";

describe("UsagePanel", () => {
  it("uses the animated counter for summary totals that are numeric displays", () => {
    const { container } = render(
      <UsagePanel
        showSummary
        summaryLabel="TOTAL"
        summaryValue="1,234,567"
      />,
    );

    expect(container.querySelector('[data-counter-root="true"]')).not.toBeNull();
  });

  it("falls back to plain text when summary value is not numeric", () => {
    const { container } = render(
      <UsagePanel
        showSummary
        summaryLabel="TOTAL"
        summaryValue="—"
      />,
    );

    expect(container.querySelector('[data-counter-root="true"]')).toBeNull();
    expect(container.textContent).toContain("—");
  });
});
