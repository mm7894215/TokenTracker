import React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

// Shared rounded dropdown built on @base-ui/react Select. Replaces native
// HTML <select> elements so the open list matches the app's design (rounded
// corners, shadow, hover states) on every platform — a native select popup is
// OS-rendered and can't be styled. The popup uses base-ui's default portal,
// which renders it above the page so it escapes ancestor `overflow` clipping.

const TRIGGER_BASE =
  "relative inline-flex items-center justify-between gap-2 rounded-lg border " +
  "border-oai-gray-200 bg-white text-oai-black transition-colors " +
  "hover:border-oai-gray-300 focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 " +
  "dark:bg-oai-gray-900 dark:text-white dark:hover:border-oai-gray-700";

/**
 * @param {object} props
 * @param {*} props.value - currently selected value
 * @param {(value:*) => void} props.onValueChange
 * @param {Array<{value:*, label:React.ReactNode, disabled?:boolean}>} props.options
 * @param {string} [props.ariaLabel]
 * @param {string} [props.id] - id for the trigger button (lets a `<label htmlFor>` associate)
 * @param {boolean} [props.disabled]
 * @param {React.ReactNode} [props.leadingIcon] - icon rendered before the value
 * @param {string} [props.className] - extra classes for the trigger button
 * @param {string} [props.popupClassName] - extra classes for the popup
 * @param {"start"|"center"|"end"} [props.align]
 * @param {boolean} [props.matchTriggerWidth] - size the popup to the trigger
 */
export function Select({
  value,
  onValueChange,
  options = [],
  ariaLabel,
  id,
  disabled = false,
  leadingIcon = null,
  className = "",
  popupClassName = "",
  align = "start",
  matchTriggerWidth = false,
}) {
  const items = options.map((opt) => ({ value: opt.value, label: opt.label }));

  return (
    <BaseSelect.Root
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (!disabled && next != null) onValueChange?.(next);
      }}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          TRIGGER_BASE,
          disabled &&
            "cursor-not-allowed opacity-50 hover:border-oai-gray-200 dark:hover:border-oai-gray-800",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {leadingIcon}
          <BaseSelect.Value className="truncate" />
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400"
          aria-hidden
        />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align={align}
          side="bottom"
          sideOffset={4}
          className="z-50"
        >
          <BaseSelect.Popup
            className={cn(
              "max-h-[min(18rem,var(--available-height))] origin-[var(--transform-origin)] overflow-y-auto",
              "rounded-xl border border-oai-gray-200 bg-white p-1 shadow-lg ring-1 ring-black/[0.04]",
              "dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:ring-white/[0.05]",
              "transition-[opacity,transform] duration-150 ease-out",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              matchTriggerWidth && "min-w-[var(--anchor-width)]",
              popupClassName,
            )}
          >
            <BaseSelect.List role="listbox" aria-label={ariaLabel}>
              {options.map((opt) => (
                <BaseSelect.Item
                  key={String(opt.value)}
                  value={opt.value}
                  disabled={opt.disabled}
                  className={({ selected, disabled: itemDisabled }) =>
                    cn(
                      "flex w-full cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg py-1.5 pl-1.5 pr-6",
                      "text-left text-xs outline-none transition-colors",
                      selected
                        ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800/70 dark:text-white"
                        : "text-oai-gray-600 hover:bg-oai-gray-50 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800/60",
                      itemDisabled &&
                        "cursor-not-allowed opacity-50 hover:bg-transparent dark:hover:bg-transparent",
                    )
                  }
                >
                  <span className="flex w-3.5 shrink-0 items-center justify-center text-oai-gray-500 dark:text-oai-gray-300">
                    <BaseSelect.ItemIndicator>
                      <Check className="h-3 w-3" aria-hidden />
                    </BaseSelect.ItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <BaseSelect.ItemText>{opt.label}</BaseSelect.ItemText>
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
