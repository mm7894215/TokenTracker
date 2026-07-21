import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsforgeUserHeaderControls } from "./InsforgeUserHeaderControls.jsx";

const authMock = vi.hoisted(() => ({
  state: {
    enabled: true,
    loading: false,
    signedIn: true,
    user: null,
    displayName: "Alice",
  },
  signOut: vi.fn(async () => {}),
}));

const loginMock = vi.hoisted(() => ({ openLoginModal: vi.fn() }));

vi.mock("../contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => ({ ...authMock.state, signOut: authMock.signOut }),
}));

vi.mock("../contexts/LoginModalContext.jsx", () => ({
  useLoginModal: () => loginMock,
}));

vi.mock("../hooks/useLocale.js", () => ({ useLocale: () => ({}) }));
vi.mock("../lib/native-bridge.js", () => ({ isNativeApp: () => false }));

const LABELS = {
  "header.auth.sign_in_aria": "Sign in",
  "header.auth.open_account_menu": "Open account menu",
  "header.auth.open_settings": "Open settings",
  "nav.settings": "Settings",
  "nav.achievements": "Achievements",
  "settings.account.signOut": "Sign out",
};

vi.mock("../lib/copy", () => ({ copy: (key) => LABELS[key] || key }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderSidebarAccount(onAfterAction = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <InsforgeUserHeaderControls variant="sidebar" onAfterAction={onAfterAction} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return onAfterAction;
}

describe("InsforgeUserHeaderControls sidebar account menu", () => {
  beforeEach(() => {
    authMock.state = {
      enabled: true,
      loading: false,
      signedIn: true,
      user: null,
      displayName: "Alice",
    };
    authMock.signOut.mockClear();
    loginMock.openLoginModal.mockClear();
  });

  it("moves Settings, Achievements, and Sign out into the signed-in menu", async () => {
    const user = userEvent.setup();
    const onAfterAction = renderSidebarAccount();

    const trigger = screen.getByRole("button", { name: "Open account menu" });
    await act(async () => user.click(trigger));

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Achievements" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();

    await act(async () => user.click(screen.getByRole("menuitem", { name: "Achievements" })));
    expect(screen.getByTestId("location")).toHaveTextContent("/achievements");
    expect(onAfterAction).toHaveBeenCalledTimes(1);

    await act(async () => user.click(trigger));
    await act(async () => user.click(screen.getByRole("menuitem", { name: "Sign out" })));
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it("keeps Settings and Achievements available while signed out", async () => {
    authMock.state = { ...authMock.state, signedIn: false, displayName: "" };
    const user = userEvent.setup();
    renderSidebarAccount();

    await act(async () => user.click(screen.getByRole("button", { name: "Open account menu" })));

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Achievements" })).toBeInTheDocument();
    await act(async () => user.click(screen.getByRole("menuitem", { name: "Sign in" })));
    expect(loginMock.openLoginModal).toHaveBeenCalledTimes(1);
  });

  it("closes the menu for outside pointers and Escape", async () => {
    const user = userEvent.setup();
    renderSidebarAccount();
    const trigger = screen.getByRole("button", { name: "Open account menu" });

    await act(async () => user.click(trigger));
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await act(async () => user.click(trigger));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
