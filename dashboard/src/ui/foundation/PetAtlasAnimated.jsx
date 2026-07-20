import React, { useEffect, useMemo, useState } from "react";
import { normalizePetCharacter } from "../../lib/pet-personality.js";

const ROWS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export function petAtlasRowForState(state) {
  if (["error", "disconnected", "working-overheated"].includes(state)) return "failed";
  if (["happy", "waking", "mini-happy", "jumping"].includes(state)) return "jumping";
  if (["working-typing", "working-ultrathink", "working-juggling", "running"].includes(state)) return "running";
  if (["working-thinking", "working-wizard", "review"].includes(state)) return "review";
  if (["sleeping", "idle-doze", "mini-sleep", "waiting"].includes(state)) return "waiting";
  if (["mini-peek", "waving"].includes(state)) return "waving";
  if (state === "running-left" || state === "running-right") return state;
  return "idle";
}

// Pause the frame timer while the page is hidden (background tab, or the Windows
// pet window after HidePet() — which hides rather than closes the WebView2 host),
// mirroring PetAtlasSpriteView's `paused: !isVisible` so an invisible pet never
// keeps waking the renderer.
function usePageVisible() {
  const [visible, setVisible] = useState(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  });
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function PetAtlasAnimated({
  character,
  pet = null,
  state = "idle-living",
  dragState = null,
  size = 48,
  className = "",
  lookDirectionIndex = null,
}) {
  const id = normalizePetCharacter(character);
  const rowId = dragState === "running-left" || dragState === "running-right"
    ? dragState
    : petAtlasRowForState(state);
  const row = ROWS[rowId];
  const spriteVersionNumber = pet?.spriteVersionNumber === 2 ? 2 : 1;
  const atlasRows = spriteVersionNumber === 2 ? 11 : 9;
  const lookIndex = spriteVersionNumber === 2 && rowId === "idle" && Number.isInteger(lookDirectionIndex)
    ? ((lookDirectionIndex % 16) + 16) % 16
    : null;
  const displayedRow = lookIndex == null ? row.row : 9 + Math.floor(lookIndex / 8);
  const displayedFrame = lookIndex == null ? null : lookIndex % 8;
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (reducedMotion || !pageVisible || lookIndex != null) return undefined;
    let cancelled = false;
    let timer = 0;
    const advance = (current) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const next = (current + 1) % row.durations.length;
        setFrame(next);
        advance(next);
      }, row.durations[current]);
    };
    advance(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lookIndex, reducedMotion, pageVisible, row]);

  const style = useMemo(() => ({
    width: size * (192 / 208),
    height: size,
    backgroundImage: `url(${pet?.assetUrl || `/pets/${id}/spritesheet.webp`})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `800% ${atlasRows * 100}%`,
    backgroundPosition: `${((displayedFrame ?? frame) / 7) * 100}% ${(displayedRow / (atlasRows - 1)) * 100}%`,
    imageRendering: "pixelated",
  }), [atlasRows, displayedFrame, displayedRow, frame, id, pet?.assetUrl, size]);

  return <div aria-hidden="true" className={`pet-atlas-animated ${className}`} style={style} />;
}
