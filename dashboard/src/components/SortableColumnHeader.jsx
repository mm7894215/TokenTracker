import React, { useLayoutEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../lib/cn";

/**
 * Draggable column header. In addition to its own sortable transform,
 * it imperatively mirrors the same transform/transition to every
 * `<td data-column-key="{id}">` in the table so the entire column
 * translates together in real time — not just after drop.
 */
export function SortableColumnHeader({ id, thClassName, children }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const transformStr = CSS.Transform.toString(transform) || "";

  useLayoutEffect(() => {
    // `id` is always a safe snake_case identifier from LEADERBOARD_TOKEN_COLUMNS,
    // so a raw attribute selector is fine — no escaping needed.
    const cells = document.querySelectorAll(`td[data-column-key="${id}"]`);
    const liftShadow =
      "0 2px 10px rgba(15, 23, 42, 0.10), 0 1px 3px rgba(15, 23, 42, 0.06)";
    cells.forEach((cell) => {
      cell.style.transform = transformStr;
      cell.style.transition = transition || "";
      cell.style.zIndex = isDragging ? "20" : "";
      cell.style.position = transformStr ? "relative" : "";
      cell.style.boxShadow = isDragging ? liftShadow : "";
    });
    return () => {
      cells.forEach((cell) => {
        cell.style.transform = "";
        cell.style.transition = "";
        cell.style.zIndex = "";
        cell.style.position = "";
        cell.style.boxShadow = "";
      });
    };
  }, [id, transformStr, transition, isDragging]);

  const style = {
    transform: transformStr,
    transition,
    position: transformStr ? "relative" : undefined,
    zIndex: isDragging ? 20 : undefined,
    boxShadow: isDragging
      ? "0 2px 10px rgba(15, 23, 42, 0.10), 0 1px 3px rgba(15, 23, 42, 0.06)"
      : undefined,
  };

  return (
    <th
      ref={setNodeRef}
      style={style}
      className={cn(
        thClassName,
        "group/col select-none cursor-grab active:cursor-grabbing touch-none",
      )}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center justify-end gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "-mr-1 inline-flex h-4 w-3 shrink-0 items-center justify-center text-oai-gray-400 dark:text-oai-gray-600",
            "opacity-0 transition-opacity duration-150 group-hover/col:opacity-100",
            isDragging && "opacity-100",
          )}
        >
          <svg viewBox="0 0 8 14" width="8" height="14" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2" r="1" />
            <circle cx="6" cy="2" r="1" />
            <circle cx="2" cy="7" r="1" />
            <circle cx="6" cy="7" r="1" />
            <circle cx="2" cy="12" r="1" />
            <circle cx="6" cy="12" r="1" />
          </svg>
        </span>
        {children}
      </div>
    </th>
  );
}
