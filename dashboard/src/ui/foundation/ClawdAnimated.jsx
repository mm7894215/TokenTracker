import React, { useState, useEffect, useRef } from "react";

/**
 * SVG path mapping: state name → file path under /clawd/
 */
const STATE_TO_PATH = {
  // Idle
  "idle-living": "idle/living.svg",
  "idle-doze": "idle/doze.svg",
  "idle-follow": "idle/follow.svg",
  "idle-look": "idle/look.svg",
  "idle-yawn": "idle/yawn.svg",
  "idle-collapse": "idle/collapse.svg",

  // Working
  "working-building": "working/building.svg",
  "working-carrying": "working/carrying.svg",
  "working-conducting": "working/conducting.svg",
  "working-confused": "working/confused.svg",
  "working-debugger": "working/debugger.svg",
  "working-juggling": "working/juggling.svg",
  "working-overheated": "working/overheated.svg",
  "working-pushing": "working/pushing.svg",
  "working-sweeping": "working/sweeping.svg",
  "working-thinking": "working/thinking.svg",
  "working-typing": "working/typing.svg",
  "working-ultrathink": "working/ultrathink.svg",
  "working-wizard": "working/wizard.svg",

  // Mini
  "mini-alert": "mini/alert.svg",
  "mini-crabwalk": "mini/crabwalk.svg",
  "mini-enter": "mini/enter.svg",
  "mini-enter-sleep": "mini/enter-sleep.svg",
  "mini-happy": "mini/happy.svg",
  "mini-idle": "mini/idle.svg",
  "mini-peek": "mini/peek.svg",
  "mini-sleep": "mini/sleep.svg",

  // React
  "react-double": "react/double.svg",
  "react-drag": "react/drag.svg",
  "react-left": "react/left.svg",
  "react-right": "react/right.svg",

  // Sleep
  "collapse-sleep": "sleep/collapse-sleep.svg",
  "sleeping": "sleep/sleeping.svg",
  "wake": "sleep/wake.svg",

  // Status
  "disconnected": "status/disconnected.svg",
  "error": "status/error.svg",
  "notification": "status/notification.svg",

  // Other
  "happy": "happy.svg",
  "static-base": "static-base.svg",
};

/** Module-level SVG text cache */
const svgCache = new Map();

async function fetchSvg(path) {
  if (svgCache.has(path)) return svgCache.get(path);
  const resp = await fetch(`/clawd/${path}`);
  if (!resp.ok) return null;
  const raw = await resp.text();
  // Strip fixed width/height so SVG scales to container, keep viewBox
  const result = raw.replace(/<svg([^>]*)>/, (_match, attrs) => {
    const cleaned = attrs
      .replace(/\s+width="[^"]*"/g, "")
      .replace(/\s+height="[^"]*"/g, "");
    return `<svg${cleaned} width="100%" height="100%">`;
  });
  svgCache.set(path, result);
  return result;
}

/**
 * Clawd animated SVG component.
 * Inlines SVG so CSS @keyframes animations work natively.
 *
 * @param {string} state - Animation state name (e.g. "idle-living", "working-typing")
 * @param {number} size - Display size in pixels
 * @param {string} className - Additional CSS classes
 */
export function ClawdAnimated({ state = "idle-living", size = 48, className = "" }) {
  const [svgHtml, setSvgHtml] = useState("");
  const containerRef = useRef(null);
  const reducedMotion = useReducedMotion();

  const effectiveState = reducedMotion ? "static-base" : state;
  const path = STATE_TO_PATH[effectiveState] || STATE_TO_PATH["static-base"];

  useEffect(() => {
    let cancelled = false;
    fetchSvg(path).then((html) => {
      if (!cancelled && html) setSvgHtml(html);
    });
    return () => { cancelled = true; };
  }, [path]);

  // Crop viewBox to actual content bbox so the character fills the container
  useEffect(() => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    try {
      const bbox = svg.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const pad = 2;
        svg.setAttribute(
          "viewBox",
          `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`,
        );
      }
    } catch {
      // Some SVGs do not expose getBBox until fully rendered.
    }
  }, [svgHtml]);

  return (
    <div
      ref={containerRef}
      className={`clawd-animated ${className}`}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  );
}

/** All available animation state names */
export const CLAWD_STATES = Object.keys(STATE_TO_PATH);

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}
