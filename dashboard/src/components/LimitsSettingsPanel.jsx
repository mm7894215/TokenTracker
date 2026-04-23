import React, { useState } from "react";
import { LayoutGroup, motion } from "motion/react";
import { GripVertical } from "lucide-react";
import {
  LIMIT_PROVIDER_NAMES,
  LIMIT_PROVIDER_ICONS,
} from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

// Providers whose brand logo is a pure mono glyph (fill="currentColor")
// — these render black in <img> and must be inverted under dark mode.
// Colored logos (claude, codex, gemini, antigravity) are left as-is.
const MONO_LOGO_PROVIDERS = new Set(["cursor", "kiro", "copilot"]);

function ToggleSwitch({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        checked ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-700",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

/**
 * Bare drag-and-drop reorder + visibility list for usage-limit providers.
 * Renders only the row list — outer chrome (card, header) is supplied by the
 * surrounding container (e.g. SettingsPage SectionCard).
 *
 * `prefs` is the return value of `useLimitsDisplayPrefs()`.
 */
export function LimitsSettingsPanel({ prefs }) {
  const { order, visibility, toggle, moveToward } = prefs;
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const handleDragStart = (id) => (e) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (draggingId && draggingId !== id && dragOverId !== id) {
      setDragOverId(id);
      moveToward(draggingId, id);
    }
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDraggingId(null);
    setDragOverId(null);
  };

  return (
    <LayoutGroup>
      <div className="flex flex-col">
        {order.map((id) => {
          const visible = visibility[id] !== false;
          const isDragging = draggingId === id;
          return (
            <motion.div
              key={id}
              layout
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              draggable
              onDragStart={handleDragStart(id)}
              onDragOver={handleDragOver(id)}
              onDragEnd={handleDragEnd}
              onDrop={handleDrop}
              className={cn(
                "flex items-center gap-3 py-2 rounded-md",
                "hover:bg-oai-gray-100/60 dark:hover:bg-oai-gray-800/60",
                isDragging && "opacity-40",
              )}
              style={{ cursor: isDragging ? "grabbing" : "grab" }}
            >
              <GripVertical
                className="h-4 w-4 shrink-0 text-oai-gray-400 dark:text-oai-gray-500"
                strokeWidth={1.75}
                aria-hidden
              />

              <img
                src={LIMIT_PROVIDER_ICONS[id]}
                alt=""
                width={18}
                height={18}
                className={cn(
                  "h-[18px] w-[18px] shrink-0 pointer-events-none",
                  MONO_LOGO_PROVIDERS.has(id) && "dark:invert",
                )}
                draggable={false}
              />

              <span className="flex-1 text-sm text-oai-gray-900 dark:text-oai-gray-200 select-none">
                {LIMIT_PROVIDER_NAMES[id]}
              </span>

              <div
                onMouseDown={(e) => e.stopPropagation()}
                draggable={false}
              >
                <ToggleSwitch
                  checked={visible}
                  onChange={() => toggle(id)}
                  ariaLabel={`${copy("limits.settings.toggle_visible")}: ${LIMIT_PROVIDER_NAMES[id]}`}
                />
              </div>
            </motion.div>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
