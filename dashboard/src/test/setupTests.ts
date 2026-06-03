import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => (storage.has(key) ? storage.get(key) ?? null : null),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      get length() {
        return storage.size;
      },
    },
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: () => {},
  });
}
