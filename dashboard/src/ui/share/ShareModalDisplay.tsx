import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
// @ts-ignore — ShareCard.jsx has no .d.ts; runtime shape is fine.
import { ShareCard } from "./ShareCard.jsx";
import { IDENTITY_CARD_VARIANT } from "./share-card-constants";
import { getSharePreviewScale } from "./get-share-preview-scale";
import type { Toast } from "./share-modal-utils";

const PREVIEW_SHELL_CHROME_CLASSNAME =
  "rounded-[24px] ring-1 ring-black/5 shadow-[0_24px_60px_rgba(15,23,42,0.10)] overflow-visible";
const PREVIEW_SHELL_PLAIN_CLASSNAME = "overflow-visible";

function usePreviewScale(width: number, height: number) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () =>
      setScale(
        getSharePreviewScale({
          cardWidth: width,
          cardHeight: height,
          maxWidth: node.clientWidth,
          maxHeight: node.clientHeight,
        }),
      );
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [height, width]);

  return { scale, viewportRef };
}

export function ShareCardPreview({ cardRef, data, width, height, busy }: any) {
  const { scale, viewportRef } = usePreviewScale(width, height);
  const previewShellClassName =
    data?.variant === IDENTITY_CARD_VARIANT
      ? PREVIEW_SHELL_PLAIN_CLASSNAME
      : PREVIEW_SHELL_CHROME_CLASSNAME;
  return (
    <div className="flex-1 min-w-0 min-h-0 p-5 sm:p-8 bg-oai-gray-50 dark:bg-oai-gray-950">
      <div ref={viewportRef} className="flex h-full w-full items-center justify-center overflow-auto">
        <div
          style={{ width: width * scale, height: height * scale, flexShrink: 0, position: "relative" }}
          className={previewShellClassName}
        >
          {busy ? <GeneratingOverlay /> : null}
          <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <ShareCard ref={cardRef} data={data} variant={data?.variant} />
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneratingOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-black/50">
      <svg className="animate-spin h-6 w-6 text-oai-gray-500" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  );
}

export function ShareToast({ toast }: { toast: Toast | null }) {
  return (
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
  );
}
