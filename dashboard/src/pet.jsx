import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { pickQuip, normalizePetLocale, petLabels } from "./lib/pet-quips.js";

/**
 * Standalone floating-pet entry for the Windows tray app (PetWindow.cs loads
 * `/pet.html?app=1`). Deliberately tiny: it renders ONLY the animated Clawd
 * companion on a fully transparent surface — no router, providers, sidebar or
 * global styles.
 *
 * Behaviour mirrors the macOS popover companion (ClawdCompanionView.swift):
 *   • Auto state: today's token VOLUME drives only the hover bubble, NOT the
 *     animation. Calm idle (living/look, rotating every 12–25s) is the resting
 *     state; sleeping at 0 usage; disconnected when the API is unreachable.
 *   • tap (click in place) → cycles the "fun" animations in order, 2.5s each.
 *   • drag (left-press + move) → moves the window (host runs the OS move loop).
 *   • right-click → opens the full dashboard panel.
 *
 * State source: the pet runs in its own WebView2 partition, so it can't read the
 * dashboard's localStorage NOR should it poll usage independently (that drifts
 * from the tray). The native host pushes EVERYTHING — currency, locale, today's
 * usage (the same numbers the tray's UsagePoller fetched), syncing + connection —
 * via `window.__ttPet*` globals + `pet:*` events, so the pet always matches the tray.
 */

const TAP_HOLD_MS = 2500;
// Pointer travel (px) past which a left-press is treated as a drag, not a tap.
// Kept generous: an ordinary click jitters a few px, and once a drag is detected
// the native HTCAPTION move loop takes over (the window can't snap back to a tap),
// so too small a value makes every click nudge the pet's position.
const DRAG_THRESHOLD = 10;
// Top band reserved for the bubble so it never overlaps Clawd (the host sizes the
// window height to include this — keep in sync with PetWindow.SizeDimensions).
const BUBBLE_BAND = 28;

// Hover lean (macOS parity): while the cursor is over the pet, Clawd leans toward it
// (ClawdCompanionView shifts the body ±1.2px and the eyes a touch more, ≈7% of width).
// We approximate that with a horizontal lean + a small tilt, proportional to how far
// the cursor sits from center (−1 = far left … +1 = far right). Small center deadzone.
const LEAN_DEADZONE = 0.12;
const LEAN_MAX_SHIFT_FRAC = 0.07; // translateX, as a fraction of the sprite size
const LEAN_MAX_TILT_DEG = 3;      // subtle tilt toward the cursor, for a "looking" feel
// Eyes additionally glance toward the cursor, in SVG user units (the artboard is 15
// wide), on top of the body lean — mirrors macOS hoverEyeShift (±0.5px in a 15-grid).
const EYE_GLANCE_UNITS = 0.6;

// Tapping cycles these in order — the full macOS tapAnimations set. Heads-up: the last
// two (sleeping, error) are "sploot" poses that flatten the crab onto the floor (torso
// drops from y6 to y10–15), so tapping into them makes it visibly lie down. The crab
// stays horizontally anchored (feet/shadow pinned) — it just lowers, by design.
const TAP_ANIMATIONS = [
  "working-ultrathink",
  "working-typing",
  "disconnected",
  "idle-look",
  "idle-doze",
  "sleeping",
  "error",
];
// Idle variety: rotate every 12–25s, weighted toward the calm "living" pose.
const IDLE_VARIANTS = ["idle-living", "idle-look", "idle-living", "idle-living", "idle-look"];

function readPetUsage() {
  const tk = Number(window.__ttPetTokens);
  const cost = Number(window.__ttPetCostUsd);
  return {
    tokens: Number.isFinite(tk) ? tk : 0,
    costUsd: Number.isFinite(cost) ? cost : 0,
  };
}

function readPetConnected() {
  // Default to connected until the host says otherwise.
  return window.__ttPetConnected !== false;
}

function readPetCurrency() {
  const c = typeof window !== "undefined" ? window.__ttPetCurrency : null;
  const rate = Number(c?.rate);
  return {
    symbol: c?.symbol || "$",
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
  };
}

function readPetLocale() {
  return normalizePetLocale(typeof window !== "undefined" ? window.__ttPetLocale : null);
}

// Matches the tray's UsagePoller.FormatTokens exactly (always 1 decimal) so the
// pet bubble and the tray "今日" line read identically for the same number.
function formatTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function post(type) {
  try { window.chrome?.webview?.postMessage(type); } catch { /* not in WebView2 */ }
}

function sizeFor() {
  // The sprite tracks the smaller of (width, height MINUS the reserved bubble band),
  // so it fills the lower area without growing into the bubble's space.
  return Math.max(40, Math.min(window.innerWidth, window.innerHeight - BUBBLE_BAND) - 8);
}

// ── Fixed-frame Clawd renderer (macOS parity) ────────────────────────────────
//
// The macOS companion frames every pose on the character's fixed 15×16 artboard
// (ClawdCompanionView: `.frame(width: 15*px, height: 16*px)`), so the crab never
// rescales or drifts between states. The shared web <ClawdAnimated> instead re-crops
// the viewBox to each pose's OWN content bbox (getBBox), which makes the sprite jump
// in size + position on every tap. We can't change that shared component (it's in the
// mac/web main bundle), so the pet renders Clawd itself, pinning the fixed frame.
//
// Every clawd SVG draws the character at the same coords (torso ~x2–13, y6–15); the
// animated poses just add overshoot padding around it. Pinning viewBox "0 0 15 16"
// frames exactly the character on every pose — identical scale + anchor, like macOS.
const CLAWD_FRAME_VIEWBOX = "0 0 15 16";

// The poses the pet shows (subset of ClawdAnimated.STATE_TO_PATH), kept local so the
// shared component stays untouched.
const PET_STATE_TO_PATH = {
  "idle-living": "idle/living.svg",
  "idle-look": "idle/look.svg",
  "idle-doze": "idle/doze.svg",
  "working-typing": "working/typing.svg",
  "working-ultrathink": "working/ultrathink.svg",
  "sleeping": "sleep/sleeping.svg",
  "disconnected": "status/disconnected.svg",
  "error": "status/error.svg",
  "static-base": "static-base.svg",
};

const petSvgCache = new Map();
async function fetchPetSvg(path) {
  if (petSvgCache.has(path)) return petSvgCache.get(path);
  const resp = await fetch(`/clawd/${path}`);
  if (!resp.ok) return null;
  const raw = await resp.text();
  // Strip the SVG's own sizing and pin the fixed character frame so every pose scales
  // + anchors identically (no per-pose bbox crop). Keep the inlined <style>/@keyframes
  // so the animations still run.
  const result = raw.replace(/<svg([^>]*)>/, (_m, attrs) => {
    const cleaned = attrs
      .replace(/\s+width="[^"]*"/g, "")
      .replace(/\s+height="[^"]*"/g, "")
      .replace(/\s+viewBox="[^"]*"/g, "")
      .replace(/\s+preserveAspectRatio="[^"]*"/g, "");
    return `<svg${cleaned} viewBox="${CLAWD_FRAME_VIEWBOX}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">`;
  });
  petSvgCache.set(path, result);
  return result;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Animated Clawd locked to the fixed 15×16 character frame (see above), with the eyes
 * glancing toward the cursor while hovering (`leanX`, −1..+1).
 *
 * Each pose wraps its eyes in a <g> whose class/id contains "eye" (e.g. eyes-look,
 * eyes-focus, eyes-read). Those groups already run their own blink/track transform
 * animations, which would override any transform we set directly — so after a pose
 * loads we wrap each (non-shut) eye group in our own <g> and translate THAT, letting
 * the inner animation keep running relative to it.
 */
function PetClawd({ state, size, leanX }) {
  const [svgHtml, setSvgHtml] = useState("");
  const containerRef = useRef(null);
  const eyeWrapsRef = useRef([]);
  const leanRef = useRef(leanX);
  const path = PET_STATE_TO_PATH[state] || PET_STATE_TO_PATH["static-base"];

  useEffect(() => {
    let cancelled = false;
    fetchPetSvg(path).then((html) => { if (!cancelled && html) setSvgHtml(html); });
    return () => { cancelled = true; };
  }, [path]);

  // After each pose loads, wrap its outermost (open) eye group(s) so we can glance them.
  useEffect(() => {
    eyeWrapsRef.current = [];
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const matches = Array.from(svg.querySelectorAll('[class*="eye"],[id*="eye"]'));
    // Keep only the outermost eye element(s) (drop nested blink groups, etc.).
    const outer = matches.filter((el) => !matches.some((o) => o !== el && o.contains(el)));
    for (const el of outer) {
      const tag = `${el.getAttribute("class") || ""} ${el.id || ""}`;
      if (/shut|closed|sleep/i.test(tag)) continue; // closed eyes — nothing to glance
      const wrap = document.createElementNS(SVG_NS, "g");
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
      eyeWrapsRef.current.push(wrap);
    }
    applyGlance(leanRef.current);
  }, [svgHtml]);

  // Glance the eyes toward the cursor whenever the lean changes.
  useEffect(() => {
    leanRef.current = leanX;
    applyGlance(leanX);
  }, [leanX]);

  function applyGlance(lx) {
    const dx = lx * EYE_GLANCE_UNITS;
    for (const w of eyeWrapsRef.current) w.setAttribute("transform", `translate(${dx},0)`);
  }

  return (
    <div
      ref={containerRef}
      className="clawd-animated"
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

/** Compact translucent pill shown in the top band (usage on hover, or a tap quip). */
function Bubble({ text }) {
  return (
    <div
      style={{
        maxWidth: "98%",
        padding: "3px 9px",
        borderRadius: 10,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.3,
        color: "#fff",
        background: "rgba(20,20,22,0.86)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {text}
    </div>
  );
}

function Pet() {
  const [today, setToday] = useState(readPetUsage);
  const [connected, setConnected] = useState(readPetConnected);
  const [currency, setCurrency] = useState(readPetCurrency);
  const [locale, setLocale] = useState(readPetLocale);
  const [isSyncing, setIsSyncing] = useState(false);
  const [userTyping, setUserTyping] = useState(false);
  const [rage, setRage] = useState(false);
  const [idleVariant, setIdleVariant] = useState("idle-living");
  const [tapState, setTapState] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [hovering, setHovering] = useState(false);
  const [leanX, setLeanX] = useState(0); // −1..+1, cursor offset from center while hovering
  const [size, setSize] = useState(sizeFor);
  const dragRef = useRef(null);
  const tapIndexRef = useRef(0);
  const tapTimer = useRef(0);
  const idleTimer = useRef(0);

  // Usage + connection are pushed by the native host (same numbers the tray shows),
  // so the pet never drifts from the app and does no independent polling.
  useEffect(() => {
    const update = () => setToday(readPetUsage());
    update();
    window.addEventListener("pet:usage", update);
    return () => window.removeEventListener("pet:usage", update);
  }, []);
  useEffect(() => {
    const update = () => setConnected(readPetConnected());
    update();
    window.addEventListener("pet:connected", update);
    return () => window.removeEventListener("pet:connected", update);
  }, []);

  // Currency + locale pushed by the native host.
  useEffect(() => {
    const update = () => setCurrency(readPetCurrency());
    update();
    window.addEventListener("pet:currency", update);
    return () => window.removeEventListener("pet:currency", update);
  }, []);
  useEffect(() => {
    const update = () => setLocale(readPetLocale());
    update();
    window.addEventListener("pet:locale", update);
    return () => window.removeEventListener("pet:locale", update);
  }, []);
  // Syncing state pushed by the native host (drives the typing animation, like macOS).
  useEffect(() => {
    const update = () => setIsSyncing(Boolean(window.__ttPetSyncing));
    update();
    window.addEventListener("pet:syncing", update);
    return () => window.removeEventListener("pet:syncing", update);
  }, []);
  // The native host detects global typing activity (count-only, no key content) and
  // pushes it here so Clawd types along while you type — anywhere.
  useEffect(() => {
    const update = () => setUserTyping(Boolean(window.__ttPetTyping));
    update();
    window.addEventListener("pet:typing", update);
    return () => window.removeEventListener("pet:typing", update);
  }, []);
  // "Overheat" gag: after the host sees ~30s of non-stop typing it sets this; Clawd
  // plays the error (fanning/steaming = cooling off) pose for a ~30s cooldown.
  useEffect(() => {
    const update = () => setRage(Boolean(window.__ttPetRage));
    update();
    window.addEventListener("pet:rage", update);
    return () => window.removeEventListener("pet:rage", update);
  }, []);

  // Keep Clawd filling the window as the host resizes it.
  useEffect(() => {
    const onResize = () => setSize(sizeFor());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Hover is driven by the native host (PetWindow polls the OS cursor vs the
  // window rect and pushes `window.__ttPetHover` + a `pet:hover` event). DOM
  // mouse-leave is unreliable on this transparent, never-activated topmost window
  // — it would leave the bubble stuck — so we don't use it.
  useEffect(() => {
    const update = () => setHovering(Boolean(window.__ttPetHover));
    update();
    window.addEventListener("pet:hover", update);
    return () => window.removeEventListener("pet:hover", update);
  }, []);

  // When the cursor leaves, straighten Clawd back up (no stuck lean — DOM moves stop
  // firing on leave, so the host's hover signal is what tells us we've left).
  useEffect(() => {
    if (!hovering) setLeanX(0);
  }, [hovering]);

  // Idle variant rotation (macOS startIdleVariantLoop): 12–25s, weighted calm.
  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      const delay = 12_000 + Math.random() * 13_000;
      idleTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        setIdleVariant(IDLE_VARIANTS[Math.floor(Math.random() * IDLE_VARIANTS.length)]);
        schedule();
      }, delay);
    };
    schedule();
    return () => { cancelled = true; clearTimeout(idleTimer.current); };
  }, []);

  useEffect(() => () => clearTimeout(tapTimer.current), []);

  // Auto state — overheat(rage) > disconnected > syncing/you-typing > sleeping(0) >
  // idle. Token volume affects only the bubble, not the animation.
  const isDisconnected = !connected;
  let autoState;
  if (rage) autoState = "error";
  else if (isDisconnected) autoState = "disconnected";
  else if (isSyncing || userTyping) autoState = "working-typing";
  else if (today.tokens === 0) autoState = "sleeping";
  else autoState = idleVariant;

  const state = tapState || autoState;

  // Tap → reaction animation + a spoken quip (macOS handleTap parity), both held
  // for TAP_HOLD_MS then cleared.
  const triggerTap = useCallback(() => {
    const anim = TAP_ANIMATIONS[tapIndexRef.current % TAP_ANIMATIONS.length];
    tapIndexRef.current += 1;
    setTapState(anim);
    // Feed the quip the SAME formatted figures the hover bubble shows, so a tap can
    // bake in today's real token count + cost (macOS parity) instead of staying generic.
    const costValue = today.costUsd * currency.rate;
    setSpeech(pickQuip(locale, {
      tokens: today.tokens,
      tokensText: formatTokens(today.tokens),
      costText: `${currency.symbol}${costValue.toFixed(2)}`,
      costValue,
      isSyncing,
    }));
    clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      setTapState(null);
      setSpeech(null);
    }, TAP_HOLD_MS);
  }, [locale, today.tokens, today.costUsd, currency.symbol, currency.rate, isSyncing]);

  // Distinguish a tap (→ cycle animation) from a drag (→ native window move):
  // only hand the move to the OS once the pointer travels past a small threshold.
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, dragging: false };
  }, []);
  const onMouseMove = useCallback((e) => {
    const d = dragRef.current;
    // Hover lean: track the cursor's horizontal position (unless we're mid-drag) so
    // Clawd leans toward it. The pet receives moves across its whole window, so just
    // sliding the cursor left/right over it drives the lean — no click needed.
    if (!d || !d.dragging) {
      let f = (e.clientX / window.innerWidth - 0.5) * 2; // −1 (left) … +1 (right)
      if (Math.abs(f) < LEAN_DEADZONE) f = 0;
      setLeanX(Math.max(-1, Math.min(1, f)));
    }
    if (!d || d.dragging) return;
    if (Math.abs(e.clientX - d.x) > DRAG_THRESHOLD || Math.abs(e.clientY - d.y) > DRAG_THRESHOLD) {
      d.dragging = true;
      // The native move loop swallows the matching mouseup, so clear the drag ref now —
      // otherwise `dragging` stays true and suppresses hover lean + taps until the next click.
      dragRef.current = null;
      post("pet:drag"); // native move loop takes over from here
    }
  }, []);
  const onMouseUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.dragging) triggerTap();
  }, [triggerTap]);
  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    post("pet:context-menu");
  }, []);

  // Speech quip (on tap) takes priority over the hover usage readout.
  const L = petLabels(locale);
  const usageText = isDisconnected
    ? L.offline
    : isSyncing
      ? L.syncing
      : today.tokens > 0
        ? `${L.today} ${formatTokens(today.tokens)} · ${currency.symbol}${(today.costUsd * currency.rate).toFixed(2)}`
        : L.noUsage;
  const bubbleText = speech ?? (hovering ? usageText : null);

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={onContextMenu}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Top band: the bubble lives here, above Clawd — never overlapping it. */}
      <div
        style={{
          height: BUBBLE_BAND,
          flexShrink: 0,
          width: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        {bubbleText && <Bubble text={bubbleText} />}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Lean toward the cursor while hovering — pivot at the feet so it tilts like
            a body lean, smoothed so the discrete cursor samples read as fluid. */}
        <div
          style={{
            transform: `translateX(${leanX * size * LEAN_MAX_SHIFT_FRAC}px) rotate(${leanX * LEAN_MAX_TILT_DEG}deg)`,
            transformOrigin: "50% 92%",
            transition: "transform 0.12s ease-out",
          }}
        >
          <PetClawd state={state} size={size} leanX={leanX} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("pet-root")).render(
  <React.StrictMode>
    <Pet />
  </React.StrictMode>,
);
