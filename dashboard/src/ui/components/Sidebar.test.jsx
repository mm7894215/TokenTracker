import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout, getNavGroups } from "./Sidebar.jsx";

vi.mock("../../hooks/useTheme.js", () => ({
  useTheme: () => ({
    theme: "system",
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}));

vi.mock("../../hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

vi.mock("../../lib/native-bridge.js", () => ({
  isNativeApp: () => false,
  isNativeEmbed: () => false,
  isNativeWindowsApp: () => false,
}));

function navIds(groups) {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}

function renderLayout() {
  return render(
    <MemoryRouter>
      <AppLayout>
        <main>{"Dashboard"}</main>
      </AppLayout>
    </MemoryRouter>,
  );
}

describe("getNavGroups", () => {
  it("hides leaderboard by default on local dashboard hosts", () => {
    expect(window.location.hostname).toBe("localhost");
    expect(navIds(getNavGroups())).not.toContain("leaderboard");
  });

  it("keeps leaderboard available when explicitly enabled for hosted/cloud UI", () => {
    expect(navIds(getNavGroups({ includeLeaderboard: true }))).toContain("leaderboard");
  });
});

describe("AppLayout sidebar collapse", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to collapsed when no sidebar preference has been stored", () => {
    renderLayout();

    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/token tracker version/i)).toHaveTextContent(/^v\d+\.\d+\.\d+/);
    expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
  });

  it("stores expanded state after clicking expand and shows nav labels", () => {
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: /expand sidebar/i }));

    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("0");
    expect(screen.getByRole("button", { name: /collapse sidebar/i })).toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /star on github/i })).not.toBeInTheDocument();
  });

  it("stores collapsed state after clicking collapse and hides nav labels", () => {
    window.localStorage.setItem("tt.sidebarCollapsed", "0");
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: /collapse sidebar/i }));

    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("1");
    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeInTheDocument();
    expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
  });

  it("does not show the desktop collapse toggle inside the mobile drawer", () => {
    const { container } = renderLayout();

    fireEvent.click(screen.getByRole("button", { name: /open navigation menu/i }));

    const drawer = container.querySelector(".lg\\:hidden aside");
    expect(drawer).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: /close navigation menu/i })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /expand sidebar|collapse sidebar/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/user profile|sign in/i)).not.toBeInTheDocument();
  });

  it("does not render account sign-in controls in the sidebar", () => {
    window.localStorage.setItem("tt.sidebarCollapsed", "0");
    renderLayout();

    expect(screen.queryByText(/user profile|sign in/i)).not.toBeInTheDocument();
  });
});
