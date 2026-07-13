import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { copy } from "../../../../lib/copy";
import { DataDetails } from "../DataDetails.jsx";

// Same as TrendMonitor.test.jsx: the zoom modal's import graph pulls
// use-trend-data via a .js specifier vitest can't resolve; it never renders
// here (zoomConfig=null), so stub it out.
vi.mock("../TrendMonitorZoomModal", () => ({ TrendMonitorZoomModal: () => null }));

vi.mock("../../../../lib/api", () => ({
  getProjectUsageDetail: vi.fn(() =>
    Promise.resolve({
      project_key: "acme/alpha",
      project_ref: "https://github.com/acme/alpha",
      totals: {
        total_tokens: 1000,
        billable_total_tokens: 1000,
        input_tokens: 100,
        output_tokens: 80,
        cached_input_tokens: 700,
        cache_creation_input_tokens: 100,
        reasoning_output_tokens: 20,
        conversation_count: 12,
      },
      first_active: "2026-04-19T10:00:00.000Z",
      last_active: "2026-04-20T10:00:00.000Z",
      days_active: 2,
      range_total_tokens: 2000,
      daily: [
        { day: "2026-04-19", total_tokens: 550 },
        { day: "2026-04-20", total_tokens: 450 },
      ],
      sources: [
        {
          source: "claude",
          total_tokens: 900,
          conversation_count: 10,
          days_active: 2,
        },
      ],
    }),
  ),
}));

const baseEntry = {
  project_key: "acme/alpha",
  project_ref: "https://github.com/acme/alpha",
  total_tokens: "1000",
  billable_total_tokens: "1000",
  last_active: "2026-04-20T10:00:00.000Z",
  sources: [
    { source: "claude", total_tokens: 900 },
    { source: "codex", total_tokens: 100 },
  ],
};

function renderProjects(props = {}) {
  const result = render(
    <DataDetails
      projectEntries={[baseEntry]}
      projectLimit={3}
      copy={copy}
      dailyBreakdownRows={[]}
      dailyBreakdownColumns={[]}
      toggleSort={() => {}}
      renderDetailDate={() => null}
      renderDetailCell={() => null}
      DETAILS_PAGED_PERIODS={new Set()}
      period="month"
      detailsPageCount={0}
      detailsPage={0}
      setDetailsPage={() => {}}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: copy("dashboard.projects.title") }));
  return result;
}

it("renders project rows without external links", () => {
  renderProjects();
  expect(screen.getByText("alpha")).toBeInTheDocument();
  expect(document.querySelector("a[href]")).toBeNull();
});

it("shows the empty state when there are no projects", () => {
  renderProjects({ projectEntries: [] });
  expect(screen.getByText(copy("dashboard.projects.empty"))).toBeInTheDocument();
});

it("opens the drill-down modal on row click and loads detail data", async () => {
  renderProjects();
  fireEvent.click(screen.getByText("alpha"));

  await waitFor(() => {
    expect(
      screen.getByText(copy("dashboard.projects.detail.stat_cache_hit")),
    ).toBeInTheDocument();
  });
  // cache hit rate = 700 / (100 + 700)
  expect(screen.getByText("88%")).toBeInTheDocument();
  // share of all usage = 1000 / 2000
  expect(screen.getByText("50%")).toBeInTheDocument();
});

it("closes the modal via the close button", async () => {
  renderProjects();
  fireEvent.click(screen.getByText("alpha"));
  const closeButton = await screen.findByLabelText(
    copy("dashboard.projects.detail.close_aria"),
  );
  fireEvent.click(closeButton);
  fireEvent.animationEnd(closeButton.closest(".fixed"));
  await waitFor(() => {
    expect(
      screen.queryByLabelText(copy("dashboard.projects.detail.close_aria")),
    ).toBeNull();
  });
});
