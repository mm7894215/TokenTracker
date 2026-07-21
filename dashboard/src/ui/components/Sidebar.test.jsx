import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./Sidebar.jsx";

const LABELS = {
  "nav.group.general": "General",
  "nav.group.tools": "Tools",
  "nav.group.account": "Account",
  "nav.usage": "Usage",
  "nav.limits": "Limits",
  "nav.leaderboard": "Leaderboard",
  "nav.achievements": "Achievements",
  "nav.widgets": "Widgets",
  "nav.pet": "Desktop pet",
  "nav.skills": "Skills",
  "nav.ip_check": "IP check",
  "nav.settings": "Settings",
  "nav.expand": "Expand sidebar",
  "nav.collapse": "Collapse sidebar",
  "nav.update.download": "Download update {{version}}",
  "nav.update.in_progress": "Updating…",
  "nav.menu": "Open navigation menu",
  "nav.close_menu": "Close navigation menu",
  "nav.aside_label": "Main navigation",
  "nav.nav_label": "Primary navigation",
};

const appUpdateMock = vi.hoisted(() => ({
  state: { available: false, latestVersion: "", busy: false },
  requestUpdate: vi.fn(),
}));

const sidebarBrandingMock = vi.hoisted(() => ({ visible: true }));

vi.mock("../../lib/copy", () => ({
  copy: (key, params) => Object.entries(params || {}).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    LABELS[key] || key,
  ),
}));

vi.mock("../../hooks/useTheme.js", () => ({
  useTheme: () => ({ theme: "system", resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("../../hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

vi.mock("../../hooks/use-app-update.js", () => ({
  useAppUpdate: () => ({ ...appUpdateMock.state, requestUpdate: appUpdateMock.requestUpdate }),
}));

vi.mock("../../hooks/use-sidebar-branding.js", () => ({
  useSidebarBranding: () => ({ visible: sidebarBrandingMock.visible }),
}));

vi.mock("../../lib/native-bridge.js", () => ({
  isNativeApp: () => false,
  isNativeEmbed: () => false,
  isNativeWindowsApp: () => false,
}));

vi.mock("../dashboard/util/should-fetch-github-stars.js", () => ({
  shouldFetchGithubStars: () => false,
}));

vi.mock("../../components/InsforgeUserHeaderControls.jsx", () => ({
  InsforgeUserHeaderControls: ({ collapsed }) => (
    <button type="button" aria-label="Account control" data-collapsed={collapsed ? "true" : "false"} />
  ),
}));

let desktopMatches = false;
let mediaListeners;

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AppLayout>
        <main />
      </AppLayout>
    </MemoryRouter>,
  );
}

describe("AppLayout navigation sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    appUpdateMock.state = { available: false, latestVersion: "", busy: false };
    appUpdateMock.requestUpdate.mockClear();
    sidebarBrandingMock.visible = true;
    desktopMatches = false;
    mediaListeners = new Set();
    window.matchMedia = vi.fn((query) => ({
      matches: query === "(min-width: 1024px)" ? desktopMatches : false,
      media: query,
      onchange: null,
      addEventListener: (_type, listener) => mediaListeners.add(listener),
      removeEventListener: (_type, listener) => mediaListeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("collapses and expands the desktop sidebar while persisting the preference", async () => {
    const user = userEvent.setup();
    renderLayout();

    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    });

    expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("1");
    expect(screen.getByRole("link", { name: "Usage" })).toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    });

    expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("0");
  });

  it("keeps the star beside the brand and account utilities in one footer row", () => {
    renderLayout();

    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    const brandRow = sidebar.querySelector('[data-sidebar-brand-row="true"]');
    const accountRow = sidebar.querySelector('[data-sidebar-account-row="true"]');

    expect(within(brandRow).getByRole("link", { name: "Token Tracker" })).toBeInTheDocument();
    expect(within(brandRow).getByRole("link", { name: "Star on GitHub" })).toBeInTheDocument();
    expect(within(accountRow).getByRole("button", { name: "Account control" })).toBeInTheDocument();
    expect(within(accountRow).getByRole("button", { name: "Theme" })).toBeInTheDocument();
    expect(within(accountRow).getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Achievements" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("hides the optional brand row when the appearance preference is off", () => {
    sidebarBrandingMock.visible = false;
    renderLayout();

    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    expect(sidebar.querySelector('[data-sidebar-brand-row="true"]')).toBeNull();
  });

  it("shows an available native update at the lower left and launches the updater", async () => {
    appUpdateMock.state = { available: true, latestVersion: "v0.84.0", busy: false };
    const user = userEvent.setup();
    renderLayout();

    const updateButton = screen.getByRole("button", { name: "Download update v0.84.0" });
    expect(updateButton).toHaveAttribute("data-app-update-button", "true");

    await act(async () => {
      await user.click(updateButton);
    });

    expect(appUpdateMock.requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("closes the narrow-window drawer from its dedicated close button", async () => {
    const user = userEvent.setup();
    renderLayout();

    const openButton = screen.getByRole("button", { name: "Open navigation menu" });
    await act(async () => {
      await user.click(openButton);
    });

    expect(openButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Main navigation" })).toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Close navigation menu" }));
    });

    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(openButton).toHaveAttribute("aria-expanded", "false");
  });

  it("clears an open drawer when the window crosses into the desktop layout", async () => {
    const user = userEvent.setup();
    renderLayout();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
    });
    expect(screen.getByRole("dialog", { name: "Main navigation" })).toBeInTheDocument();

    act(() => {
      desktopMatches = true;
      mediaListeners.forEach((listener) => listener({ matches: true }));
    });

    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();
  });
});
