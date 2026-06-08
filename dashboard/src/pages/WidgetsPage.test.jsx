import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../lib/copy";
import { EN_LOCALE, ZH_CN_LOCALE } from "../lib/locale";
import { WidgetsPage } from "./WidgetsPage.jsx";

function installNativeBridge(settings) {
  const messages = [];
  window.history.pushState({}, "", "/widgets?app=1");
  window.webkit = {
    messageHandlers: {
      nativeBridge: {
        postMessage(message) {
          messages.push(message);
        },
      },
    },
  };
  return {
    messages,
    pushSettings() {
      window.dispatchEvent(new CustomEvent("native:settings", { detail: settings }));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setCopyLocale(EN_LOCALE);
  window.history.pushState({}, "", "/");
  if (typeof window.localStorage?.removeItem === "function") {
    window.localStorage.removeItem("tokentracker_native_app");
  }
  delete window.webkit;
});

describe("WidgetsPage menu bar configurator", () => {
  it("edits the two menu bar preview slots through NativeBridge", async () => {
    const user = userEvent.setup();
    const bridge = installNativeBridge({
      showStats: true,
      menuBarItems: ["todayTokens", "claude5h"],
      menuBarMaxItems: 2,
      menuBarAvailableItems: [
        { id: "todayTokens", label: "Today Tokens", shortLabel: "Tokens", category: "tokens" },
        { id: "todayCost", label: "Today Cost", shortLabel: "Cost", category: "cost" },
        { id: "claude5h", label: "Claude 5h Limit", shortLabel: "Cl 5h", category: "limits" },
      ],
    });

    render(<WidgetsPage />);
    act(() => bridge.pushSettings());

    const secondaryLabel = copy("menubar.slot.secondary");
    const primary = await screen.findByRole("combobox", { name: copy("menubar.slot.primary") });
    const secondary = screen.getByRole("combobox", { name: secondaryLabel });

    // The slots are now custom (base-ui) dropdowns: the trigger renders the
    // selected option's label as text rather than exposing a native value.
    expect(primary).toHaveTextContent(copy("menubar.metric.today_tokens"));
    expect(secondary).toHaveTextContent(copy("menubar.metric.claude_5h"));

    // Open the secondary dropdown and verify it dedupes the primary's metric.
    await act(async () => {
      await user.click(secondary);
    });
    // The popup mounts asynchronously (base-ui portal + floating-ui positioning),
    // so wait for the listbox rather than querying synchronously right after the
    // click — a sync getByRole races the mount and fails intermittently.
    const listbox = await screen.findByRole("listbox", { name: secondaryLabel });
    expect(
      within(listbox).queryByRole("option", { name: copy("menubar.metric.today_tokens") }),
    ).not.toBeInTheDocument();

    // Pick "Today Cost". A touch tap commits without first highlighting the
    // item — base-ui's mouse path requires a highlighted item, which jsdom's
    // lack of layout for floating-ui list navigation never sets.
    const todayCostOption = within(listbox).getByRole("option", {
      name: copy("menubar.metric.today_cost"),
    });
    await act(async () => {
      await user.pointer([
        { keys: "[TouchA>]", target: todayCostOption },
        { keys: "[/TouchA]", target: todayCostOption },
      ]);
    });

    await waitFor(() => {
      expect(bridge.messages).toContainEqual({
        type: "setSetting",
        key: "menuBarItems",
        value: ["todayTokens", "todayCost"],
      });
    });
  });

  it("localizes Codex Spark native menu item labels through copy", async () => {
    setCopyLocale(ZH_CN_LOCALE);
    const bridge = installNativeBridge({
      showStats: true,
      menuBarItems: ["codexSpark5h", "codexSpark7d"],
      menuBarMaxItems: 2,
      menuBarAvailableItems: [
        {
          id: "codexSpark5h",
          label: "Codex Spark 5h Limit",
          shortLabel: "Cx Spark 5h",
          category: "limits",
        },
        {
          id: "codexSpark7d",
          label: "Codex Spark 7d Limit",
          shortLabel: "Cx Spark 7d",
          category: "limits",
        },
      ],
    });

    render(<WidgetsPage />);
    act(() => bridge.pushSettings());

    const primary = await screen.findByRole("combobox", { name: copy("menubar.slot.primary") });
    const secondary = screen.getByRole("combobox", { name: copy("menubar.slot.secondary") });

    expect(primary).toHaveTextContent(copy("menubar.metric.codex_spark_5h"));
    expect(secondary).toHaveTextContent(copy("menubar.metric.codex_spark_7d"));
  });
});
