import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "../../../hooks/useLocale.js";
import { setCopyLocale, copy } from "../../../lib/copy";
import { EN_LOCALE, LOCALE_STORAGE_KEY, ZH_CN_LOCALE } from "../../../lib/locale";
import { LocaleProvider } from "../LocaleProvider.jsx";

function createStorage(seed = {}) {
  const store = { ...seed };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
  };
}

function LocaleProbe() {
  const { setLocale } = useLocale();

  return (
    <>
      <span data-testid="language-label">{copy("settings.appearance.language.label")}</span>
      <button type="button" onClick={() => setLocale(ZH_CN_LOCALE)}>
        zh
      </button>
      <button type="button" onClick={() => setLocale(EN_LOCALE)}>
        en
      </button>
    </>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createStorage({ [LOCALE_STORAGE_KEY]: EN_LOCALE }),
  });
  document.documentElement.lang = "";
  setCopyLocale(EN_LOCALE);
});

it("updates localized copy immediately when the language changes", async () => {
  const user = userEvent.setup();

  render(
    <LocaleProvider>
      <LocaleProbe />
    </LocaleProvider>,
  );

  expect(screen.getByTestId("language-label")).toHaveTextContent("Language");
  expect(document.documentElement.lang).toBe("en");

  await act(async () => {
    await user.click(screen.getByRole("button", { name: "zh" }));
  });

  expect(screen.getByTestId("language-label")).toHaveTextContent("语言");
  expect(document.documentElement.lang).toBe("zh-CN");

  await act(async () => {
    await user.click(screen.getByRole("button", { name: "en" }));
  });

  expect(screen.getByTestId("language-label")).toHaveTextContent("Language");
  expect(document.documentElement.lang).toBe("en");
});
