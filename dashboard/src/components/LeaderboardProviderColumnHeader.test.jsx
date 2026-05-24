import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LeaderboardProviderColumnHeader } from "./LeaderboardProviderColumnHeader.jsx";

describe("LeaderboardProviderColumnHeader", () => {
  it("inverts the monochrome Kimi logo in dark mode", () => {
    const { container } = render(
      <LeaderboardProviderColumnHeader iconSrc="/brand-logos/kimi.svg" label="Kimi" />,
    );

    const img = container.querySelector('img[src="/brand-logos/kimi.svg"]');
    expect(img).toHaveClass("dark:invert");
  });
});
