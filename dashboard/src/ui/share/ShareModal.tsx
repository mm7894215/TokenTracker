import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { copy } from "../../lib/copy";
import { safeWriteClipboardImage } from "../../lib/safe-browser";
// @ts-ignore — InsforgeAuthContext.jsx has no .d.ts
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
// @ts-ignore — ShareCard.jsx has no .d.ts; the runtime shape is fine.
import { DEFAULT_SHARE_CARD_VARIANT, IDENTITY_CARD_VARIANT, getVariantSize } from "./ShareCard.jsx";
import { ShareCardPreview, ShareToast } from "./ShareModalDisplay";
import {
  ShareActionPanel,
} from "./ShareModalParts";
import {
  isNativeEmbed,
  makeColorSeed,
  pickAvatarUrl,
  useToast,
  type ShareAction,
} from "./share-modal-utils";
import {
  defaultShareVisibleStats,
  normalizeVisibleStats,
  toggleVisibleStat,
  type ShareRankPeriod,
  type ShareStatId,
} from "./share-card-options";
import { useShareRank } from "./use-share-rank";

const DEFAULT_RANK_PERIOD: ShareRankPeriod = "total";

export function ShareModal({ open, onClose, data, twitterText }: any) {
  const [busy, setBusy] = useState(null as ShareAction);
  const [handleOverride, setHandleOverride] = useState("");
  const [variant, setVariant] = useState(DEFAULT_SHARE_CARD_VARIANT);
  const [colorSeed, setColorSeed] = useState(() => makeColorSeed());
  const [rankPeriod, setRankPeriod] = useState(DEFAULT_RANK_PERIOD);
  const [visibleStats, setVisibleStats] = useState(() => defaultShareVisibleStats());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const { toast, push } = useToast();

  const insforge = useInsforgeAuth();
  const avatarUrl = pickAvatarUrl(insforge?.user);
  const optionsEnabled = variant === IDENTITY_CARD_VARIANT;
  const rankAvailable = Boolean(insforge?.signedIn && insforge?.user);
  const rankEnabled = optionsEnabled && rankAvailable;
  const accountName = typeof insforge?.displayName === "string" ? insforge.displayName.trim() : "";
  const defaultHandle = accountName || data?.handle || "";
  const rank = useShareRank({
    enabled: open === true && rankEnabled,
    fallbackRank: rankEnabled ? data?.rank ?? null : null,
    getAccessToken: insforge?.getAccessToken,
    period: rankPeriod,
    user: insforge?.user,
  });

  useEffect(() => {
    const isOpen = open === true;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!isOpen || wasOpen) return;
    setBusy(null);
    setColorSeed(makeColorSeed());
    setHandleOverride(defaultHandle);
    setRankPeriod(DEFAULT_RANK_PERIOD);
    setVisibleStats(defaultShareVisibleStats({ rankEnabled: rankAvailable }));
  }, [open, defaultHandle, rankAvailable]);

  const normalizedVisibleStats = normalizeVisibleStats(visibleStats, { rankEnabled });

  const cardData = data
    ? {
        ...data,
        variant,
        handle: handleOverride || defaultHandle || data.handle,
        avatarUrl,
        colorSeed,
        rank: optionsEnabled ? (rankEnabled ? rank : null) : data.rank,
        rankPeriod: optionsEnabled ? rankPeriod : data.rankPeriod,
        visibleStats: optionsEnabled ? normalizedVisibleStats : data.visibleStats,
      }
    : data;

  const { width: cardW, height: cardH } = getVariantSize(variant);

  useEffect(() => {
    if (open !== true) return;
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

  const buildFilename = useCallback(() => `tokentracker-share-${Date.now()}.png`, []);

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

  const openXIntent = useCallback((intentUrl: URL) => {
    if (!isNativeEmbed()) {
      window.open(intentUrl.toString(), "_blank", "noopener,noreferrer");
      return;
    }
    try {
      (window as any).webkit?.messageHandlers?.nativeBridge?.postMessage({
        type: "action",
        name: "openURL",
        value: intentUrl.toString(),
      });
    } catch {
      window.open(intentUrl.toString(), "_blank", "noopener,noreferrer");
    }
  }, []);

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
      if (copied) push(copy("share.toast.copied"), "success");
      else downloadBlobAsFile(blob, buildFilename());
    }
    const intentUrl = new URL("https://twitter.com/intent/tweet");
    if (twitterText) intentUrl.searchParams.set("text", twitterText);
    openXIntent(intentUrl);
    setBusy(null);
  }, [busy, ensureCardBlob, push, twitterText, buildFilename, openXIntent]);

  const toggleStat = useCallback((id: ShareStatId) => {
    setVisibleStats((current) => toggleVisibleStat(current, id, { rankEnabled }));
  }, [rankEnabled]);

  if (open !== true) return null;

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
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative w-full max-w-[1540px] max-h-[92vh] overflow-hidden rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-black shadow-oai-lg"
      >
        <div className="flex flex-col lg:flex-row max-h-[92vh] min-h-0">
          <ShareCardPreview
            cardRef={cardRef}
            data={cardData}
            width={cardW}
            height={cardH}
            busy={busy}
          />
          <ShareActionPanel
            busy={busy}
            handleOverride={handleOverride}
            onClose={onClose}
            onCopy={handleCopy}
            onDownload={handleDownload}
            onHandleChange={setHandleOverride}
            onRankPeriodChange={setRankPeriod}
            onShareX={handleShareX}
            onVariantChange={setVariant}
            onVisibleStatToggle={toggleStat}
            optionsEnabled={optionsEnabled}
            rankEnabled={rankEnabled}
            rankPeriod={rankPeriod}
            variant={variant}
            visibleStats={normalizedVisibleStats}
          />
        </div>
        <ShareToast toast={toast} />
      </motion.div>
    </div>
  );
}
