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

  it("renders Qoder from the Lobe Icons brand asset", () => {
    const { container } = render(<ProviderIcon provider="qoder" size={20} />);
    const icon = container.querySelector('img[src="/brand-logos/qoder.svg"]');

    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("dark:invert");
  });

  it("keeps the theme-aware placeholder for unknown providers", () => {
    const { container } = render(<ProviderIcon provider="unknown-provider" />);
    const placeholder = container.querySelector("svg");

    expect(placeholder).toHaveClass("text-oai-gray-400", "dark:text-oai-gray-500");
    expect(placeholder?.querySelector("circle")).not.toBeNull();
  });

  it("renders the MiniMax brand mark instead of the unknown-provider placeholder", () => {
    const { container } = render(<ProviderIcon provider="MINIMAX" size={18} />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveAttribute("width", "18");
    expect(icon).toHaveAttribute("height", "18");
    expect(icon?.querySelector("path")).not.toBeNull();
    expect(icon?.querySelector("circle")).toBeNull();
  });

  it("renders the multi-color oh-my-pi brand logo", () => {
    const { container } = render(<ProviderIcon provider="omp" size={20} />);
    const icon = container.querySelector('img[src="/brand-logos/omp.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
  });

  it("renders the multi-color Pi brand logo", () => {
    const { container } = render(<ProviderIcon provider="pi" size={18} />);
    const icon = container.querySelector('img[src="/brand-logos/pi.svg"]');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("width", "18");
  });
});
