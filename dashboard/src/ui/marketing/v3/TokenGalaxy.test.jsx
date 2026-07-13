import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getViewportHeight, TokenGalaxy } from "./TokenGalaxy";
import { DISC, orbScreenPos, orbitSpeedForViewport, sceneConfigForViewport } from "./galaxy-config";

vi.mock("three", () => ({
  WebGLRenderer: vi.fn(() => {
    throw new Error("webgl unavailable");
  }),
}));

describe("TokenGalaxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-renders the static fallback when WebGL renderer creation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(<TokenGalaxy mode="full" progressRef={{ current: 0 }} />);

    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "static");
    });
  });

  it("uses the visual viewport height that CSS vh resolves against", () => {
    expect(
      getViewportHeight(
        { innerHeight: 1461, visualViewport: { height: 844 } },
        { documentElement: { clientHeight: 844 } },
      ),
    ).toBe(844);
  });

  it("keeps provider orbs compact below the desktop breakpoint", () => {
    const { container } = render(<TokenGalaxy mode="static" progressRef={{ current: 0 }} />);
    const providerOrbs = container.querySelectorAll("[data-provider-orb]");

    expect(providerOrbs).toHaveLength(8);
    providerOrbs.forEach((orb) => {
      expect(orb).toHaveClass("flex", "h-10", "w-10", "lg:h-12", "lg:w-12");
      expect(orb).not.toHaveClass("hidden");
    });
  });

  it("keeps the compact galaxy styling through tablet-width viewports", () => {
    const { container } = render(<TokenGalaxy mode="static" progressRef={{ current: 0 }} />);
    const coreGlow = container.firstElementChild?.firstElementChild;

    expect(coreGlow).toHaveClass("h-72", "w-72", "lg:h-[28rem]", "lg:w-[28rem]");
    expect(coreGlow).not.toHaveClass("sm:h-[28rem]", "sm:w-[28rem]");
  });

  it("uses a clearly perceptible orbit speed on compact viewports", () => {
    expect(orbitSpeedForViewport({ compactViewport: true })).toBe(DISC.mobileOrbitSpeed);
    expect(DISC.mobileOrbitSpeed).toBeGreaterThan(DISC.orbitSpeed * 10);
    expect(orbitSpeedForViewport({ compactViewport: false })).toBe(DISC.orbitSpeed);
  });

  it("keeps the compact orbit centered around the token core", () => {
    const compactPositions = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle) =>
      orbScreenPos(angle, 1, true),
    );

    expect(compactPositions.map(({ top }) => top)).toEqual([68, 49, 68, 87]);
    compactPositions.forEach(({ left }) => {
      expect(left).toBeGreaterThanOrEqual(7);
      expect(left).toBeLessThanOrEqual(93);
    });
    expect(orbScreenPos(0, 1, true, 55).top).toBe(55);
  });

  it("widens the mobile camera while preserving the black-hole focal weight", () => {
    const mobile = sceneConfigForViewport({ compactViewport: true });
    const desktop = sceneConfigForViewport({ compactViewport: false });

    expect(mobile.cameraFov).toBeGreaterThan(desktop.cameraFov);
    expect(mobile.cameraZ).toBeGreaterThan(desktop.cameraZ);
    expect(mobile.cameraFov).toBe(82);
    expect(mobile.cameraZ).toBe(20);
    expect(mobile.pointScale).toBeGreaterThan(1);
    expect(mobile.lensScale).toBeGreaterThan(1);
    expect(mobile.lookAtY).toBe(DISC.yOffset);
    expect(desktop.lookAtY).toBe(0);
  });
});
