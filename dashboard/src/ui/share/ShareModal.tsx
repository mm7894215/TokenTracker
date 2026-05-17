import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { copy } from "../../lib/copy";
import { safeWriteClipboardImage } from "../../lib/safe-browser";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import {
  saveShareImageToDownloads,
  copyShareImageToClipboard,
  type SaveImageResult,
} from "./native-save";
import {
  captureShareCard,
  downloadBlobAsFile,
  blobToPngDataUrl,
} from "./capture-share-card";
import {
  ShareCard,
  SHARE_VARIANTS,
  getShareVariantLabel,
  getVariantSize,
} from "./ShareCard.jsx";

function isNativeEmbed(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as any)?.webkit?.messageHandlers?.nativeBridge);
}

const PREVIEW_MAX_WIDTH = 440;

type ToastKind = "info" | "success" | "error";
type Toast = { id: number; kind: ToastKind; text: string };

function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<number | null>(null);
  const push = useCallback((text: string, kind: ToastKind = "info") => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setToast({ id: Date.now(), kind, text });
    timerRef.current = window.setTimeout(() => setToast(null), 2800);
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return { toast, push };
}

function ActionButton({ onClick, disabled, children, emphasis, ariaLabel }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[
        "group relative flex items-center justify-between gap-3 w-full px-4 py-3 text-left",
        "rounded-lg border transition-colors",
        emphasis
          ? "border-oai-black dark:border-oai-white bg-oai-black dark:bg-oai-white text-oai-white dark:text-oai-black hover:opacity-90"
          : "border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white hover:border-oai-gray-400 dark:hover:border-oai-gray-600",
        disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function ShareModal({ open, onClose, data, twitterText }: any) {
  const [busy, setBusy] = useState<null | "x" | "copy" | "download">(null);
  const [handleOverride, setHandleOverride] = useState<string>("");
  const [variant, setVariant] = useState<string>("annual-report");
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { toast, push } = useToast();

  // Grab avatar URL from auth context for share card
  const insforge = useInsforgeAuth();
  const avatarUrl = useMemo(() => {
    const user = insforge?.user;
    if (!user || typeof user !== "object") return null;
    const meta = (user as any).user_metadata || {};
    const prof = (user as any).profile || {};
    const u = meta.avatar_url || meta.picture || prof.avatar_url || (user as any).avatar_url;
    return typeof u === "string" && u.trim() ? u.trim() : null;
  }, [insforge?.user]);

  // Reset state on open
  useEffect(() => {
    if (!open) return;
    setBusy(null);
    setHandleOverride(data?.handle || "");
  }, [open, data?.handle]);

  // Merge handle override + avatar into data for the card
  const cardData = data ? { ...data, handle: handleOverride || data.handle, avatarUrl } : data;

  // Variant-aware dimensions
  const { width: cardW, height: cardH } = getVariantSize(variant);
  const previewScale = PREVIEW_MAX_WIDTH / cardW;

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const ensureCardBlob = useCallback(async (): Promise<Blob | null> => {
    const node = cardRef.current;
    if (!node) return null;
    try {
      return await captureShareCard(node);
    } catch (error) {
      console.warn("[share] capture failed", error);
      return null;
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (busy) return;
    setBusy("copy");
    const blob = await ensureCardBlob();
    if (!blob) {
      push(copy("share.toast.failed"), "error");
      setBusy(null);
      return;
    }
    let ok = false;
    if (isNativeEmbed()) {
      const dataUrl = await blobToPngDataUrl(blob);
      if (dataUrl) {
        const result = await copyShareImageToClipboard(dataUrl);
        ok = result.ok;
      }
    } else {
      ok = await safeWriteClipboardImage(blob);
    }
    push(ok ? copy("share.toast.copied") : copy("share.toast.failed"), ok ? "success" : "error");
    setBusy(null);
  }, [busy, ensureCardBlob, push]);

  const buildFilename = useCallback(
    () => `tokentracker-share-${Date.now()}.png`,
    [],
  );

  const handleDownload = useCallback(async () => {
    if (busy) return;
    setBusy("download");
    const blob = await ensureCardBlob();
    if (!blob) {
      push(copy("share.toast.failed"), "error");
      setBusy(null);
      return;
    }
    if (isNativeEmbed()) {
      const dataUrl = await blobToPngDataUrl(blob);
      if (dataUrl) {
        const result: SaveImageResult = await saveShareImageToDownloads(
          dataUrl,
          buildFilename(),
        );
        if (result.ok) {
          push(copy("share.toast.downloaded"), "success");
          setBusy(null);
          return;
        }
      }
    }
    const ok = downloadBlobAsFile(blob, buildFilename());
    push(ok ? copy("share.toast.downloaded") : copy("share.toast.failed"), ok ? "success" : "error");
    setBusy(null);
  }, [busy, ensureCardBlob, buildFilename, push]);

  const handleShareX = useCallback(async () => {
    if (busy) return;
    setBusy("x");
    const blob = await ensureCardBlob();
    if (!blob) {
      push(copy("share.toast.failed"), "error");
      setBusy(null);
      return;
    }
    // In native WKWebView: save image via bridge, then open URL via bridge.
    // downloadBlobAsFile creates a blob: URL <a> click which navigates the
    // entire WKWebView away from the dashboard. Avoid it in native context.
    if (isNativeEmbed()) {
      const dataUrl = await blobToPngDataUrl(blob);
      if (dataUrl) {
        await saveShareImageToDownloads(dataUrl, buildFilename());
        push(copy("share.toast.downloaded"), "success");
      }
    } else {
      const copied = await safeWriteClipboardImage(blob);
      if (!copied) {
        downloadBlobAsFile(blob, buildFilename());
      } else {
        push(copy("share.toast.copied"), "success");
      }
    }
    const intentUrl = new URL("https://twitter.com/intent/tweet");
    if (twitterText) intentUrl.searchParams.set("text", twitterText);
    // Use location.href in native embed so WKUIDelegate.createWebView
    // (which intercepts window.open and opens in system browser) fires.
    // window.open with _blank sometimes navigates the WKWebView itself.
    if (isNativeEmbed()) {
      try {
        (window as any).webkit?.messageHandlers?.nativeBridge?.postMessage({
          type: "action", name: "openURL", value: intentUrl.toString(),
        });
      } catch {
        window.open(intentUrl.toString(), "_blank", "noopener,noreferrer");
      }
    } else {
      window.open(intentUrl.toString(), "_blank", "noopener,noreferrer");
    }
    setBusy(null);
  }, [busy, ensureCardBlob, push, twitterText, buildFilename]);


  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy("share.modal.title")}
      data-screenshot-exclude="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6"
      style={{ background: "rgba(10,10,10,0.72)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {/* Hidden render target for html-to-image — variant-sized.
          Uses clip + opacity to hide visually while keeping the element
          in-layout so WKWebView actually paints it (off-screen positioning
          with left:-20000 causes WKWebView to skip rendering). */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: cardW,
          height: cardH,
          pointerEvents: "none",
          opacity: 0,
          zIndex: -1,
          clip: "rect(0,0,0,0)",
          overflow: "hidden",
        }}
      >
        <ShareCard ref={cardRef} data={cardData} variant={variant} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative w-full max-w-[1040px] max-h-[92vh] overflow-hidden rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-black shadow-oai-lg"
      >
        <div className="flex flex-col lg:flex-row max-h-[92vh]">
          {/* Preview column */}
          <div className="flex-1 min-w-0 p-4 sm:p-7 bg-oai-gray-50 dark:bg-oai-gray-950 flex items-center justify-center overflow-auto">
            <div
              style={{
                width: cardW * previewScale,
                height: cardH * previewScale,
                flexShrink: 0,
                position: "relative",
              }}
              className="rounded-xl overflow-hidden shadow-oai-md ring-1 ring-black/5"
            >
              {/* Generating overlay */}
              {busy ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-black/50">
                  <svg className="animate-spin h-6 w-6 text-oai-gray-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : null}
              <div
                style={{
                  width: cardW,
                  height: cardH,
                  transform: `scale(${previewScale})`,
                  transformOrigin: "top left",
                }}
              >
                <ShareCard data={cardData} variant={variant} />
              </div>
            </div>
          </div>

          {/* Actions column */}
          <div className="w-full lg:w-[340px] flex-shrink-0 border-t lg:border-t-0 lg:border-l border-oai-gray-200 dark:border-oai-gray-800 p-5 sm:p-6 flex flex-col gap-5 overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-oai-black dark:text-oai-white">
                  {copy("share.modal.title")}
                </h2>
                <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("share.modal.subtitle")}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={copy("share.modal.close")}
                className="p-1.5 -mt-1 -mr-1 rounded-md text-oai-gray-500 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Display name */}
            <div>
              <label
                htmlFor="share-handle"
                className="text-[11px] tracking-[0.18em] uppercase text-oai-gray-500 dark:text-oai-gray-400 mb-1.5 block"
              >
                {copy("share.modal.name_label")}
              </label>
              <input
                id="share-handle"
                type="text"
                value={handleOverride}
                onChange={(e) => setHandleOverride(e.target.value)}
                placeholder={copy("share.modal.name_placeholder")}
                className="w-full px-3 py-2 text-sm rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white placeholder:text-oai-gray-400 dark:placeholder:text-oai-gray-600 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-oai-brand transition-colors"
              />
            </div>

            {/* Variant selector */}
            <div>
              <label
                className="text-[11px] tracking-[0.18em] uppercase text-oai-gray-500 dark:text-oai-gray-400 mb-1.5 block"
              >
                {copy("share.modal.style_label")}
              </label>
              <div className="flex gap-2">
                {(SHARE_VARIANTS as { id: string; labelKey?: string }[]).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVariant(v.id)}
                    className={[
                      "flex-1 px-3 py-2 text-sm rounded-lg border transition-colors",
                      variant === v.id
                        ? "border-oai-black dark:border-oai-white bg-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white font-medium"
                        : "border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 text-oai-gray-500 dark:text-oai-gray-400 hover:border-oai-gray-400 dark:hover:border-oai-gray-600",
                    ].join(" ")}
                  >
                    {getShareVariantLabel(v.id)}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-1 gap-2">
              <ActionButton onClick={handleShareX} disabled={Boolean(busy)} emphasis>
                <span className="flex items-center gap-3">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  <span className="font-medium text-sm">
                    {copy("share.modal.action.x")}
                  </span>
                </span>
                <span className="text-[11px] opacity-70">
                  {busy === "x" ? copy("share.toast.working") : copy("share.modal.hint.x")}
                </span>
              </ActionButton>

              <ActionButton onClick={handleDownload} disabled={Boolean(busy)}>
                <span className="flex items-center gap-3">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span className="font-medium text-sm">
                    {copy("share.modal.action.download")}
                  </span>
                </span>
                <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">PNG</span>
              </ActionButton>

              <ActionButton onClick={handleCopy} disabled={Boolean(busy)}>
                <span className="flex items-center gap-3">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span className="font-medium text-sm">
                    {copy("share.modal.action.copy")}
                  </span>
                </span>
                <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("share.modal.hint.copy")}
                </span>
              </ActionButton>

            </div>

            <div className="mt-auto pt-4 border-t border-oai-gray-200 dark:border-oai-gray-800">
              <p className="text-[11px] leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                {copy("share.modal.footer")}
              </p>
            </div>
          </div>
        </div>

        {/* Toast */}
        <AnimatePresence>
          {toast ? (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="pointer-events-none absolute left-1/2 bottom-4 -translate-x-1/2"
            >
              <div
                className={[
                  "px-4 py-2 rounded-full text-xs font-medium shadow-oai-md",
                  toast.kind === "error"
                    ? "bg-red-600 text-white"
                    : toast.kind === "success"
                      ? "bg-oai-black dark:bg-oai-white text-oai-white dark:text-oai-black"
                      : "bg-oai-gray-800 text-white",
                ].join(" ")}
              >
                {toast.text}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
