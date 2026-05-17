import React, { useState, useCallback } from "react";
import { Info, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { copy } from "../../lib/copy";

// Required copy keys (registered in copy.csv separately):
//   hint.dismiss            → "Dismiss hint"
//   hint.dismissible_aria   → "Dismissible hint"

const STORAGE_PREFIX = "tt:hint:dismissed:";

function storageKey(id) {
  return STORAGE_PREFIX + id;
}

function readDismissed(id) {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}

/**
 * DismissibleHint - inline hint card with a persistent "X" dismiss button.
 *
 * Once dismissed, the same `id` will stay hidden across sessions via
 * localStorage (key: `tt:hint:dismissed:<id>`).
 *
 * @param {Object} props
 * @param {string} props.id - Stable identifier used for the localStorage key.
 * @param {React.ReactNode} props.children - Hint body content.
 * @param {string} [props.className] - Extra classes merged onto the outer container.
 * @param {string} [props.ariaLabel] - Optional override for the container aria-label.
 */
export function DismissibleHint({ id, children, className, ariaLabel }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(id));

  const handleDismiss = useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(storageKey(id), "1");
      } catch {
        /* ignore quota / privacy-mode errors — UI still hides */
      }
    }
    setDismissed(true);
  }, [id]);

  if (dismissed) return null;

  return (
    <div
      role="note"
      aria-label={ariaLabel || copy("hint.dismissible_aria")}
      className={cn(
        "relative rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-4 py-3 text-sm text-oai-gray-700",
        "dark:border-oai-gray-800 dark:bg-oai-gray-900/40 dark:text-oai-gray-300",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={copy("hint.dismiss")}
        className="absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-500 transition-colors hover:bg-oai-gray-200/70 hover:text-oai-gray-700 focus:outline-none focus:ring-2 focus:ring-oai-blue/30 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800/70 dark:hover:text-oai-gray-200"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="flex items-start gap-2 pr-8">
        <Info
          className="mt-0.5 h-4 w-4 shrink-0 text-oai-gray-500 dark:text-oai-gray-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

export default DismissibleHint;
