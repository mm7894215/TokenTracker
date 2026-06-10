import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE, ZH_CN_LOCALE } from "../../../lib/locale";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";

describe("UsageLimitsPanel", () => {
  afterEach(() => {
    setCopyLocale(EN_LOCALE);
  });

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
    expect(screen.getByRole("heading", { name: /Usage Limits\s*·\s*Used/ })).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(screen.getByText("1%")).toBeInTheDocument();

    rerender(<UsageLimitsPanel kimi={{ configured: false }} order={["kimi"]} />);

    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("appends plan_label to the provider title when present", () => {
    render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          plan_label: "Pro",
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor Pro")).toBeInTheDocument();
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });

  it("renders just the provider name when plan_label is null or absent", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          plan_label: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();

    rerender(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
  });

  it("renders Codex Spark quota windows through compact copy labels", () => {
    function expectLimitRow(label, value) {
      const row = screen.getByText(label).closest("div");
      expect(row).not.toBeNull();
      expect(within(row).getByText(value)).toBeInTheDocument();
    }

    setCopyLocale(ZH_CN_LOCALE);
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 30, reset_at: 1_800_604_800, limit_window_seconds: 604800 },
          spark_primary_window: { used_percent: 4, reset_at: 1_800_000_001, limit_window_seconds: 18000 },
          spark_secondary_window: { used_percent: 18, reset_at: 1_800_604_801, limit_window_seconds: 604800 },
        }}
        order={["codex"]}
      />,
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expectLimitRow("5h", "12%");
    expectLimitRow("7d", "30%");
    expectLimitRow("Spark 5h", "4%");
    expectLimitRow("Spark 7d", "18%");
  });
});
