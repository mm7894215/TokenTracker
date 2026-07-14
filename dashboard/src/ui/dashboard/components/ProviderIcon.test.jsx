import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon.jsx";

describe("ProviderIcon", () => {
  it("renders the official AnythingLLM mark with explicit light and dark treatment", () => {
    const { container } = render(
      <ProviderIcon provider="anythingllm" size={20} className="shrink-0" />,
    );

    const icon = container.querySelector('img[src="/brand-logos/anythingllm.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
    expect(icon).toHaveClass("brightness-0", "dark:brightness-100", "shrink-0");
  });

  it("keeps the theme-aware placeholder for unknown providers", () => {
    const { container } = render(<ProviderIcon provider="unknown-provider" />);
    const placeholder = container.querySelector("svg");

    expect(placeholder).toHaveClass("text-oai-gray-400", "dark:text-oai-gray-500");
    expect(placeholder?.querySelector("circle")).not.toBeNull();
  });
});
