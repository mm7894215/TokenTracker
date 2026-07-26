import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessions } from "../lib/sessions-api";
import { SessionsPage } from "./SessionsPage.jsx";

vi.mock("../lib/sessions-api", () => ({
  getSessions: vi.fn(),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: () => true,
}));

vi.mock("../ui/components/Toast.jsx", () => ({
  showToast: vi.fn(),
}));

vi.mock("../hooks/useLocale", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

const daysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

const response = {
  from: "",
  to: "",
  available: true,
  session_count: 3,
  returned_count: 3,
  sessions: [
    {
      session_hash: "claude-row",
      session_id: "11111111-2222-3333-4444-555555555555",
      title: "Fix authentication flow",
      source: "claude",
      project_key: "tokentracker",
      project_ref: "/work/tokentracker",
      model: "claude-opus-4-8",
      started_at: "2026-07-24T08:00:00Z",
      ended_at: "2026-07-24T08:10:00Z",
      duration_ms: 600_000,
      turns: 1,
      edit_turns: 1,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 12_000,
      cost_usd: 0.25,
      productive: true,
      first_pass: true,
      resume_command: "claude --resume 11111111-2222-3333-4444-555555555555",
    },
    {
      session_hash: "codex-row",
      session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Review release",
      source: "codex",
      project_key: "lumaradio",
      project_ref: "/work/lumaradio",
      model: "gpt-5.6-sol",
      started_at: "2026-07-23T08:00:00Z",
      ended_at: "2026-07-23T08:20:00Z",
      duration_ms: 1_200_000,
      turns: 2,
      edit_turns: 0,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 8_000,
      cost_usd: 0.1,
      productive: false,
      first_pass: false,
      resume_command: "codex resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    {
      session_hash: "grok-row",
      session_id: "019f740c-e792-7fb1-a218-59ea1b340714",
      title: "Debug local proxy",
      source: "grok",
      project_key: "alphafox-web",
      project_ref: "/work/alphafox-web",
      model: "grok-4.5-build-free",
      started_at: "2026-07-22T08:00:00Z",
      ended_at: "2026-07-22T08:15:00Z",
      duration_ms: 900_000,
      turns: 3,
      edit_turns: 1,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 21_000,
      cost_usd: 0,
      productive: true,
      first_pass: true,
      resume_command: "grok --resume 019f740c-e792-7fb1-a218-59ea1b340714",
    },
  ],
};

describe("SessionsPage", () => {
  beforeEach(() => {
    getSessions.mockReset();
    getSessions.mockResolvedValue(response);
    window.localStorage.clear();
  });

  it("loads local sessions and filters them by source and search", async () => {
    render(<SessionsPage />);

    expect(await screen.findByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();
    expect(screen.getByText("Debug local proxy")).toBeInTheDocument();
    // The whole list is fetched once; no row cap and no server-side window.
    expect(getSessions).toHaveBeenCalledWith({ refresh: false });

    const sourceTabs = within(screen.getByRole("tablist", { name: "Filter by session source" }));
    fireEvent.click(sourceTabs.getByRole("tab", { name: "Codex" }));
    expect(screen.queryByText("Fix authentication flow")).not.toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();
    expect(screen.queryByText("Debug local proxy")).not.toBeInTheDocument();

    fireEvent.click(sourceTabs.getByRole("tab", { name: "Grok" }));
    expect(screen.queryByText("Review release")).not.toBeInTheDocument();
    expect(screen.getByText("Debug local proxy")).toBeInTheDocument();

    fireEvent.click(sourceTabs.getByRole("tab", { name: "All" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "auth" },
    });
    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.queryByText("Review release")).not.toBeInTheDocument();
    expect(screen.queryByText("Debug local proxy")).not.toBeInTheDocument();
  });

  it("filters the date range client-side without re-querying", async () => {
    getSessions.mockResolvedValue({
      ...response,
      session_count: 3,
      returned_count: 3,
      sessions: [
        { ...response.sessions[0], started_at: daysAgo(1), ended_at: daysAgo(1) },
        // Started well before a 7d window but ran into it: must stay visible.
        // Filtering on started_at alone used to drop exactly these.
        {
          ...response.sessions[1],
          session_hash: "spanning-row",
          title: "Long running migration",
          started_at: daysAgo(40),
          ended_at: daysAgo(2),
        },
        {
          ...response.sessions[1],
          session_hash: "old-row",
          title: "Ancient session",
          started_at: daysAgo(60),
          ended_at: daysAgo(59),
        },
      ],
    });

    render(<SessionsPage />);
    await screen.findByText("Ancient session");
    expect(getSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "7d" }));

    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Long running migration")).toBeInTheDocument();
    expect(screen.queryByText("Ancient session")).not.toBeInTheDocument();
    // Range chips filter what is already loaded — no extra round trip.
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  it("copies the project path from the project label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");

    // Titled rows expose the path on the project chip; untitled rows put it on
    // the heading (which is the project name). Both must reach the same path.
    fireEvent.click(screen.getByRole("button", { name: "Copy the local path for tokentracker" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/work/tokentracker"));

    // The tooltip carries the full path plus the click-to-copy hint.
    expect(screen.getAllByRole("tooltip")[0]).toHaveTextContent("/work/tokentracker");
    expect(screen.getAllByRole("tooltip")[0]).toHaveTextContent("Click to copy this path");
  });

  it("reports a truncated list instead of silently dropping sessions", async () => {
    getSessions.mockResolvedValue({ ...response, session_count: 1297, returned_count: 2 });
    render(<SessionsPage />);
    expect(await screen.findByText(/1297/)).toBeInTheDocument();
  });

  it("shows a retryable error instead of the empty state when loading fails", async () => {
    getSessions.mockRejectedValueOnce(new Error("boom"));
    render(<SessionsPage />);

    expect(await screen.findByText("Could not load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();

    getSessions.mockResolvedValue(response);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Fix authentication flow")).toBeInTheDocument();
  });

  it("renders a bounded window of rows and extends it on demand", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      ...response.sessions[0],
      session_hash: `row-${index}`,
      title: `Session ${index}`,
    }));
    getSessions.mockResolvedValue({
      ...response,
      session_count: many.length,
      returned_count: many.length,
      sessions: many,
    });

    render(<SessionsPage />);
    await screen.findByText("Session 0");
    expect(screen.getByText("Session 99")).toBeInTheDocument();
    expect(screen.queryByText("Session 100")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more sessions" }));
    expect(await screen.findByText("Session 149")).toBeInTheDocument();
  });
});
