import React from "react";
import { copy } from "../../lib/copy";
import { getShareVariantLabel, SHARE_VARIANTS } from "./ShareCard.jsx";
import { ShareDisplayOptions } from "./ShareModalOptions";
import type { ShareRankPeriod, ShareStatId } from "./share-card-options";
import type { ShareAction } from "./share-modal-utils";

type ActionButtonProps = {
  onClick: () => void;
  disabled: boolean;
  children: any;
  emphasis?: boolean;
  ariaLabel?: string;
};

function ActionButton({ onClick, disabled, children, emphasis, ariaLabel }: ActionButtonProps) {
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

export function ShareActionPanel({
  busy,
  handleOverride,
  onClose,
  onCopy,
  onDownload,
  onHandleChange,
  onRankPeriodChange,
  onShareX,
  onVariantChange,
  onVisibleStatToggle,
  optionsEnabled,
  rankEnabled,
  rankPeriod,
  variant,
  visibleStats,
}: {
  busy: ShareAction;
  handleOverride: string;
  onClose?: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onHandleChange: (value: string) => void;
  onRankPeriodChange: (value: ShareRankPeriod) => void;
  onShareX: () => void;
  onVariantChange: (value: string) => void;
  onVisibleStatToggle: (value: ShareStatId) => void;
  optionsEnabled: boolean;
  rankEnabled: boolean;
  rankPeriod: ShareRankPeriod;
  variant: string;
  visibleStats: ShareStatId[];
}) {
  return (
    <div className="w-full lg:w-[430px] flex-shrink-0 border-t lg:border-t-0 lg:border-l border-oai-gray-200 dark:border-oai-gray-800 p-5 sm:p-6 flex flex-col gap-6 overflow-y-auto">
      <SharePanelHeader onClose={onClose} />
      <ShareNameField value={handleOverride} onChange={onHandleChange} />
      <ShareStyleSelector value={variant} onChange={onVariantChange} />
      {optionsEnabled ? (
        <ShareDisplayOptions
          rankEnabled={rankEnabled}
          rankPeriod={rankPeriod}
          visibleStats={visibleStats}
          onRankPeriodChange={onRankPeriodChange}
          onVisibleStatToggle={onVisibleStatToggle}
        />
      ) : null}
      <ShareActionButtons busy={busy} onCopy={onCopy} onDownload={onDownload} onShareX={onShareX} />
      <SharePanelFooter />
    </div>
  );
}

function SharePanelHeader({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <h2 className="text-[25px] leading-[1.05] tracking-[-0.03em] font-semibold text-oai-black dark:text-oai-white">
          {copy("share.modal.title")}
        </h2>
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
  );
}

function ShareNameField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label
        htmlFor="share-handle"
        className="text-[11px] tracking-[0.16em] uppercase text-oai-gray-500 dark:text-oai-gray-400 mb-2 block"
      >
        {copy("share.modal.name_label")}
      </label>
      <input
        id="share-handle"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={copy("share.modal.name_placeholder")}
        className="w-full px-3 py-2 text-sm rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white placeholder:text-oai-gray-400 dark:placeholder:text-oai-gray-600 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-oai-brand transition-colors"
      />
      <p className="mt-2 text-[11px] leading-[1.6] text-oai-gray-500 dark:text-oai-gray-400">
        {copy("share.modal.name_hint")}
      </p>
    </div>
  );
}

function ShareStyleSelector({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label className="text-[11px] tracking-[0.16em] uppercase text-oai-gray-500 dark:text-oai-gray-400 mb-2 block">
        {copy("share.modal.style_label")}
      </label>
      <div className="flex gap-2">
        {SHARE_VARIANTS.map((entry: { id: string }) => (
          <StyleButton
            key={entry.id}
            active={value === entry.id}
            label={getShareVariantLabel(entry.id)}
            onClick={() => onChange(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StyleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex-1 rounded-lg border px-3 py-2.5 text-[13px] tracking-[-0.01em] transition-colors",
        active
          ? "border-oai-black bg-white font-medium text-oai-black dark:border-oai-white dark:bg-oai-gray-900 dark:text-oai-white"
          : "border-oai-gray-200 bg-white text-oai-gray-500 hover:border-oai-gray-400 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-400 dark:hover:border-oai-gray-600",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function ShareActionButtons({ busy, onCopy, onDownload, onShareX }: any) {
  return (
    <div className="grid grid-cols-1 gap-2 pt-1">
      <ActionButton onClick={onShareX} disabled={Boolean(busy)} emphasis>
        <span className="flex items-center gap-3">
          <XIcon />
          <span className="font-medium text-sm">{copy("share.modal.action.x")}</span>
        </span>
        <span className="text-[11px] opacity-70">
          {busy === "x" ? copy("share.toast.working") : copy("share.modal.hint.x")}
        </span>
      </ActionButton>
      <ActionButton onClick={onDownload} disabled={Boolean(busy)}>
        <span className="flex items-center gap-3">
          <DownloadIcon />
          <span className="font-medium text-sm">{copy("share.modal.action.download")}</span>
        </span>
        <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("share.modal.format.png")}
        </span>
      </ActionButton>
      <ActionButton onClick={onCopy} disabled={Boolean(busy)}>
        <span className="flex items-center gap-3">
          <CopyIcon />
          <span className="font-medium text-sm">{copy("share.modal.action.copy")}</span>
        </span>
        <span className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("share.modal.hint.copy")}
        </span>
      </ActionButton>
    </div>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SharePanelFooter() {
  return (
    <div className="mt-auto pt-4 border-t border-oai-gray-200 dark:border-oai-gray-800">
      <p className="text-[11px] leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
        {copy("share.modal.footer")}
      </p>
    </div>
  );
}
