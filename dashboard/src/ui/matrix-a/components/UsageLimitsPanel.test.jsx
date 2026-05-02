import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";

describe("UsageLimitsPanel", () => {
  it("shows provider status rows instead of hiding configured providers with errors", () => {
    render(
      <UsageLimitsPanel
        claude={{ configured: true, error: "Claude API returned 403" }}
        codex={{ configured: false }}
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["claude", "codex", "cursor"]}
      />,
    );

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText(/Claude API returned 403/)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("renders Kimi quota windows and not-connected state", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        kimi={{
          configured: true,
          error: null,
          parallel_limit: 20,
          primary_window: { used_percent: 64, reset_at: "2026-05-04T06:02:56.054Z" },
          secondary_window: { used_percent: 4, reset_at: "2026-05-02T05:02:56.054Z" },
          tertiary_window: { used_percent: 1, reset_at: null },
        }}
        order={["kimi"]}
      />,
    );

    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Parallel: 20")).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(screen.getByText("1%")).toBeInTheDocument();

    rerender(<UsageLimitsPanel kimi={{ configured: false }} order={["kimi"]} />);

    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });
});
