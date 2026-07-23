import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuBarSection } from "./MenuBarSection.jsx";

const nativeSettingsMock = vi.hoisted(() => ({
  settings: {
    toastOnReset: true,
    confettiOnReset: true,
    launchAtLogin: false,
    launchAtLoginSupported: true,
  },
  setSetting: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock("../../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: true,
    settings: nativeSettingsMock.settings,
    setSetting: nativeSettingsMock.setSetting,
    runAction: nativeSettingsMock.runAction,
  }),
}));

vi.mock("../../lib/copy", () => ({
  copy: (key) => key,
}));

describe("MenuBarSection limit-reset feedback", () => {
  beforeEach(() => {
    nativeSettingsMock.setSetting.mockReset();
  });

  it("shows independent toast and confetti settings", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MenuBarSection />
      </MemoryRouter>,
    );

    const toastSwitch = screen.getByRole("switch", {
      name: "settings.menubar.toastOnReset",
    });
    const confettiSwitch = screen.getByRole("switch", {
      name: "settings.menubar.confettiOnReset",
    });

    expect(toastSwitch).toHaveAttribute("aria-checked", "true");
    expect(confettiSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(toastSwitch);
      await user.click(confettiSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("toastOnReset", false);
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("confettiOnReset", false);
  });
});
