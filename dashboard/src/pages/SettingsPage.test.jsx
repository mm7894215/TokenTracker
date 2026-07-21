import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.jsx";

const nativeSettingsMock = vi.hoisted(() => ({ available: true }));

const LABELS = {
  "settings.page.title": "Settings",
  "settings.page.subtitle": "Manage your preferences",
  "settings.section.appearance": "Appearance",
  "settings.section.menubar": "Menu Bar App",
  "settings.section.account": "Account",
  "settings.section.limits": "Limits Display",
  "settings.section.labs": "Labs",
};

vi.mock("../lib/copy", () => ({
  copy: (key) => LABELS[key] || key,
}));

vi.mock("../lib/native-bridge", () => ({
  isNativeApp: () => true,
  isBridgeAvailable: () => nativeSettingsMock.available,
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  LIMIT_DISPLAY_MODES: { USED: "used", REMAINING: "remaining" },
  useLimitsDisplayPrefs: () => ({
    displayMode: "used",
    setDisplayMode: vi.fn(),
  }),
}));

vi.mock("../components/settings/AppearanceSection.jsx", () => ({
  AppearanceSection: () => <div data-testid="appearance-content" />,
}));

vi.mock("../components/settings/MenuBarSection.jsx", () => ({
  MenuBarSection: () => <div data-testid="native-content" />,
  NativeAppFooter: () => <footer data-testid="settings-footer" />,
}));

vi.mock("../components/settings/AccountSection.jsx", () => ({
  AccountSection: () => <div data-testid="account-content" />,
}));

vi.mock("../components/settings/LabsSection.jsx", () => ({
  LabsSection: () => <div data-testid="labs-content" />,
}));

vi.mock("../components/LimitsSettingsPanel.jsx", () => ({
  LimitsSettingsPanel: () => <div data-testid="limits-content" />,
}));

vi.mock("../components/settings/Controls.jsx", () => ({
  SectionCard: ({ children }) => <div>{children}</div>,
  SegmentedControl: () => <div data-testid="limits-mode" />,
}));

describe("SettingsPage category navigation", () => {
  beforeEach(() => {
    nativeSettingsMock.available = true;
  });

  it("switches the visible category while keeping every section mounted", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPage />);

    const appearanceButton = screen.getByRole("button", { name: "Appearance" });
    const accountButton = screen.getByRole("button", { name: "Account" });
    const appearancePanel = container.querySelector('[data-settings-panel="appearance"]');
    const accountPanel = container.querySelector('[data-settings-panel="account"]');

    expect(appearanceButton).toHaveAttribute("aria-current", "page");
    expect(appearancePanel).not.toHaveAttribute("hidden");
    expect(accountPanel).toHaveAttribute("hidden");
    expect(screen.getByTestId("appearance-content")).toBeInTheDocument();
    expect(screen.getByTestId("account-content")).toBeInTheDocument();

    await act(async () => {
      await user.click(accountButton);
    });

    expect(accountButton).toHaveAttribute("aria-current", "page");
    expect(appearanceButton).not.toHaveAttribute("aria-current");
    expect(appearancePanel).toHaveAttribute("hidden");
    expect(accountPanel).not.toHaveAttribute("hidden");
  });

  it("omits the native-app category when the native bridge is unavailable", () => {
    nativeSettingsMock.available = false;
    const { container } = render(<SettingsPage />);

    expect(screen.queryByRole("button", { name: "Menu Bar App" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="native-app"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
  });
});
