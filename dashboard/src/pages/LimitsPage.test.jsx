import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LimitsPage } from "./LimitsPage.jsx";

vi.mock("../hooks/use-usage-limits", () => ({
  useUsageLimits: () => ({
    data: {
      kimi: {
        configured: true,
        error: null,
        primary_window: { used_percent: 64, reset_at: "2026-05-04T06:02:56.054Z" },
      },
    },
    error: null,
    isLoading: false,
  }),
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  useLimitsDisplayPrefs: () => ({
    order: ["kimi"],
    visibility: { kimi: true },
  }),
}));

vi.mock("../ui/dashboard/components/UsageLimitsPanel.jsx", () => ({
  UsageLimitsPanel: ({ kimi }) => (
    <div data-testid="limits-panel">
      {kimi?.configured ? "Kimi connected" : "Kimi missing"}
    </div>
  ),
}));

describe("LimitsPage", () => {
  it("passes Kimi limits from the API response into the limits panel", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Kimi connected")).toBeInTheDocument();
  });
});
