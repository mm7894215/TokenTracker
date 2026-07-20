import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../lib/copy";
import { PetPage } from "./PetPage.jsx";

const petApiMocks = vi.hoisted(() => ({
  importCodexPets: vi.fn(),
  importPetPackage: vi.fn(),
  installPetFromUrl: vi.fn(),
  listCodexImportable: vi.fn(),
  removePet: vi.fn(),
}));

vi.mock("../lib/pets-api.js", () => petApiMocks);

vi.mock("../ui/foundation/ClawdAnimated.jsx", () => ({
  ClawdAnimated: ({ state, character }) => <div data-state={state} data-character={character} />,
}));

vi.mock("../ui/foundation/FadeIn.jsx", () => ({
  FadeIn: ({ children }) => <>{children}</>,
}));

vi.mock("../hooks/use-pet-catalog.js", () => ({
  usePetCatalog: () => ({
    pets: [
      { id: "clawd", displayName: "Clawd", nameKey: "pet.character.clawd", spriteVersionNumber: 1 },
      { id: "sprout", displayName: "Sprout", nameKey: "pet.character.sprout", spriteVersionNumber: 1 },
      { id: "byte", displayName: "Byte", nameKey: "pet.character.byte", spriteVersionNumber: 1 },
      { id: "ember", displayName: "Ember", nameKey: "pet.character.ember", spriteVersionNumber: 1 },
    ],
    loading: false,
    available: true,
    refresh: vi.fn(),
  }),
}));

function installNativeBridge() {
  const messages = [];
  window.history.pushState({}, "", "/pet-settings?app=1");
  window.webkit = {
    messageHandlers: {
      nativeBridge: { postMessage: (message) => messages.push(message) },
    },
  };
  return messages;
}

function installWindowsBridge() {
  const messages = [];
  window.history.pushState({}, "", "/pet-settings?app=1");
  window.chrome = {
    webview: { postMessage: (message) => messages.push(JSON.parse(message)) },
  };
  return messages;
}

beforeEach(() => {
  for (const mock of Object.values(petApiMocks)) mock.mockReset();
  // Most page tests do not exercise reverse import. Keeping discovery pending
  // avoids unrelated post-assertion state updates while the component remains mounted.
  petApiMocks.listCodexImportable.mockImplementation(() => new Promise(() => {}));
  petApiMocks.importCodexPets.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
  window.localStorage.removeItem("tokentracker_native_app");
  delete window.webkit;
  delete window.chrome;
});

describe("PetPage", () => {
  it("uses the page title without the redundant desktop companion eyebrow", () => {
    render(<PetPage />);

    expect(screen.getByRole("heading", { name: copy("pet.page.title") })).toBeInTheDocument();
    expect(screen.queryByText(copy("pet.page.eyebrow"))).not.toBeInTheDocument();
    const selectedClawd = screen.getByRole("button", { name: new RegExp(copy("pet.character.clawd")) });
    expect(selectedClawd).toHaveClass("border-oai-brand-500/40");
    expect(selectedClawd).not.toHaveClass("border-oai-black", "dark:border-white");
    expect(screen.getByRole("heading", { name: copy("pet.import.title") })).toBeInTheDocument();
  });

  it("reads and updates live desktop pet settings through the native bridge", async () => {
    const user = userEvent.setup();
    const messages = installNativeBridge();
    render(<PetPage />);

    expect(messages).toContainEqual({ type: "getPetSettings" });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("native:petSettings", {
        detail: { visible: true, character: "sprout", size: "large" },
      }));
    });

    expect(await screen.findByRole("switch", { name: copy("pet.controls.show") })).toBeChecked();
    expect(screen.getByRole("button", { name: new RegExp(copy("pet.character.sprout")) })).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: new RegExp(copy("pet.character.byte")) }));
    });
    await waitFor(() => {
      expect(messages).toContainEqual({ type: "setPetSetting", key: "character", value: "byte" });
    });
  });

  it("lets browser users preview every data state without a native host", async () => {
    const user = userEvent.setup();
    render(<PetPage />);
    const focus = screen.getByRole("button", { name: copy("pet.state.focus") });
    await act(async () => {
      await user.click(focus);
    });
    expect(focus).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(copy("pet.controls.native_only"))).toBeInTheDocument();
  });

  it("uses the WebView2 JSON bridge for Windows pet settings", async () => {
    const user = userEvent.setup();
    const messages = installWindowsBridge();
    render(<PetPage />);

    expect(messages).toContainEqual({ type: "getPetSettings" });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("native:petSettings", {
        detail: { visible: false, character: "ember", size: "small" },
      }));
    });

    const ember = await screen.findByRole("button", {
      name: new RegExp(copy("pet.character.ember")),
    });
    expect(ember).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      await user.click(screen.getByRole("button", {
        name: new RegExp(copy("pet.character.sprout")),
      }));
    });
    expect(messages).toContainEqual({ type: "setPetSetting", key: "character", value: "sprout" });
  });

  it("discovers Codex companions and imports a selected built-in pet", async () => {
    const user = userEvent.setup();
    const discovered = {
      codexDetected: true,
      importable: [{
        id: "rocky",
        displayName: "Rocky",
        description: "Built-in Codex companion.",
        spriteVersionNumber: 2,
        assetUrl: "/api/pets/codex/rocky/spritesheet.webp?v=app2",
      }],
    };
    petApiMocks.listCodexImportable
      .mockResolvedValueOnce(discovered)
      .mockResolvedValue({ codexDetected: false, importable: [] });

    render(<PetPage />);
    const browse = await screen.findByRole("button", { name: copy("pet.codex.browse") });
    await act(async () => { await user.click(browse); });
    const dialog = screen.getByRole("dialog", { name: copy("pet.codex.title") });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement));

    await act(async () => { await user.click(screen.getByRole("button", { name: /Rocky/ })); });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: new RegExp(copy("pet.codex.import")) }));
    });

    await waitFor(() => expect(petApiMocks.importCodexPets).toHaveBeenCalledWith(["rocky"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: copy("pet.codex.title") })).not.toBeInTheDocument());
  });
});
