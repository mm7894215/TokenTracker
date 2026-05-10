import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import Counter, { getCounterPlaces } from "../Counter";

describe("getCounterPlaces", () => {
  it("preserves separators and suffixes while deriving digit places", () => {
    expect(getCounterPlaces("1,234.5B")).toEqual([1000, ",", 100, 10, 1, ".", 0.1, "B"]);
  });
});

describe("Counter", () => {
  it("renders a counter root with static suffix tokens", () => {
    render(<Counter value={1.2} displayValue="1.2B" />);

    expect(screen.getByText("1.2B")).toBeInTheDocument();
    expect(document.querySelector('[data-counter-root="true"]')).not.toBeNull();
  });
});
