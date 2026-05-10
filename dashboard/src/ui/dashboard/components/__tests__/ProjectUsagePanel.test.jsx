import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../../../lib/copy";
import { formatCompactNumber } from "../../../../lib/format";
import { render } from "../../../../test/test-utils";
import { ProjectUsagePanel } from "../ProjectUsagePanel.jsx";

describe("ProjectUsagePanel", () => {
  const entry = {
    project_key: "octo/hello",
    project_ref: "https://github.com/octo/hello",
    total_tokens: 12345,
  };

  beforeEach(() => {
    document.documentElement.classList.add("screenshot-capture");
  });

  afterEach(() => {
    document.documentElement.classList.remove("screenshot-capture");
  });

  it("renders a repo card link with repository identity and usage", () => {
    render(<ProjectUsagePanel entries={[entry]} />);

    const card = screen.getByRole("link", { name: /hello/i });
    expect(card).toHaveAttribute("href", "https://github.com/octo/hello");
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText(/★/)).toBeInTheDocument();
  });

  it("prefers total tokens when billable tokens are zero", () => {
    const entryWithBillableZero = {
      project_key: "octo/alpha",
      project_ref: "https://github.com/octo/alpha",
      total_tokens: 12345,
      billable_total_tokens: 0,
    };

    render(<ProjectUsagePanel entries={[entryWithBillableZero]} />);

    const expected = formatCompactNumber("12345", {
      thousandSuffix: copy("shared.unit.thousand_abbrev"),
      millionSuffix: copy("shared.unit.million_abbrev"),
      billionSuffix: copy("shared.unit.billion_abbrev"),
      decimals: 1,
    });

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("closes the limit popup on Escape", async () => {
    const limitAria = copy("dashboard.projects.limit_aria");
    const onLimitChange = vi.fn();
    const user = userEvent.setup();

    render(<ProjectUsagePanel entries={[entry]} onLimitChange={onLimitChange} />);

    await act(async () => {
      await user.click(screen.getByLabelText(limitAria));
    });
    expect(screen.getByRole("listbox", { name: limitAria })).toBeVisible();

    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(screen.queryByRole("listbox", { name: limitAria })).not.toBeInTheDocument();
  });
});
