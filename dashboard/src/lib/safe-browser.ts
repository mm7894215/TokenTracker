function getLocalStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage || null;
}

function getClipboard() {
  if (typeof navigator === "undefined") return null;
  return navigator.clipboard || null;
}

function getClipboardItemCtor() {
  if (typeof window === "undefined") return null;
  return window.ClipboardItem || null;
}

type SafeBrowserOptions = {
  storage?: any;
  clipboard?: any;
};

export function safeGetItem(key: any, { storage }: SafeBrowserOptions = {}) {
  const target = storage ?? getLocalStorage();
  if (!target || typeof target.getItem !== "function") return null;
  try {
    return target.getItem(key);
  } catch (_e) {
    return null;
  }
}

export function safeSetItem(key: any, value: any, { storage }: SafeBrowserOptions = {}) {
  const target = storage ?? getLocalStorage();
  if (!target || typeof target.setItem !== "function") return false;
  try {
    target.setItem(key, value);
    return true;
  } catch (_e) {
    return false;
  }
}

export async function safeWriteClipboard(text: any, { clipboard }: SafeBrowserOptions = {}) {
  const target = clipboard ?? getClipboard();
  if (!target || typeof target.writeText !== "function") return false;
  try {
    await target.writeText(text);
    return true;
  } catch (_e) {
    return false;
  }
}

export async function safeWriteClipboardImage(blob: any, { clipboard }: SafeBrowserOptions = {}) {
  const target = clipboard ?? getClipboard();
  const ClipboardItemCtor = getClipboardItemCtor();
  if (!blob || !target || typeof target.write !== "function" || !ClipboardItemCtor) {
    return false;
  }
  try {
    const mimeType = blob.type || "image/png";
    const normalizedBlob =
      blob.type && blob.type !== mimeType
        ? blob.slice(0, blob.size, mimeType)
        : blob.type
          ? blob
          : blob.slice(0, blob.size, mimeType);
    const item = new ClipboardItemCtor({
      [mimeType]: normalizedBlob,
    });
    await target.write([item]);
    return true;
  } catch (_e) {
    return false;
  }
}
