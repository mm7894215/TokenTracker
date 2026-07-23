import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishUsageLimitsPreloadState,
  resetDashboardPreload,
} from "../lib/dashboard-preload.js";
import { LimitsPage } from "./LimitsPage.jsx";

const useUsageLimitsMock = vi.hoisted(() => vi.fn());
const useLimitsDisplayPrefsMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/use-usage-limits", () => ({
  useUsageLimits: useUsageLimitsMock,
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  useLimitsDisplayPrefs: useLimitsDisplayPrefsMock,
}));

vi.mock("../ui/dashboard/components/UsageLimitsPanel.jsx", () => ({
  UsageLimitsPanel: ({ kimi, codex, displayMode }) => (
    <div data-testid="limits-panel" data-display-mode={displayMode ?? "absent"}>
      {kimi?.configured ? "Kimi connected" : "Kimi missing"}
      {codex?.configured ? " Codex connected" : ""}
    </div>
  ),
}));

vi.mock("../components/LimitsPageSkeleton.jsx", () => ({
  LimitsPageSkeleton: () => <div data-testid="limits-skeleton" />,
}));

const apiLimits = {
  kimi: {
    configured: true,
    error: null,
    primary_window: { used_percent: 64, reset_at: "2026-05-04T06:02:56.054Z" },
  },
};

const preloadedLimits = {
  codex: {
    configured: true,
    error: null,
    primary_window: { used_percent: 22, reset_at: 1_779_999_999 },
  },
};

describe("LimitsPage", () => {
  beforeEach(() => {
    resetDashboardPreload();
    useUsageLimitsMock.mockReset();
    useUsageLimitsMock.mockImplementation(() => ({
      data: apiLimits,
      error: null,
      isLoading: false,
    }));
    useLimitsDisplayPrefsMock.mockReset();
    useLimitsDisplayPrefsMock.mockImplementation(() => ({
      order: ["kimi"],
      visibility: { kimi: true },
      displayMode: "used",
    }));
  });

  it("passes Kimi limits from the API response into the limits panel", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Kimi connected")).toBeInTheDocument();
  });

  it("uses matching preloaded limits as the hook initial state and skips the full skeleton", () => {
    publishUsageLimitsPreloadState(preloadedLimits);
    useUsageLimitsMock.mockImplementation((options) => ({
      data: options.initialState?.data,
      error: null,
      isLoading: false,
    }));

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(useUsageLimitsMock).toHaveBeenCalledWith({
      initialRefresh: true,
      initialState: expect.objectContaining({
        data: preloadedLimits,
        source: "dashboard-existing",
      }),
      publishToPreloadCache: true,
    });
    expect(screen.queryByTestId("limits-skeleton")).not.toBeInTheDocument();
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("Codex connected");
  });

  it("keeps the initialRefresh path when no preloaded state exists", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(useUsageLimitsMock).toHaveBeenCalledWith({
      initialRefresh: true,
      publishToPreloadCache: true,
    });
  });

  it("forwards the active displayMode to the limits panel", () => {
    useLimitsDisplayPrefsMock.mockImplementation(() => ({
      order: ["kimi"],
      visibility: { kimi: true },
      displayMode: "remaining",
    }));

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("limits-panel")).toHaveAttribute(
      "data-display-mode",
      "remaining",
    );
  });

  it("opens Settings directly on the Limits Display section", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Display settings" })).toHaveAttribute(
      "href",
      "/settings?section=limits",
    );
  });
});
