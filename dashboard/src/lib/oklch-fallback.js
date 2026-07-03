// Older WebView2 / Chromium (<111) cannot parse oklch() and drop the whole
// color to transparent. CSS custom properties are guarded with an @supports
// gate in styles.css, but JS-generated inline styles (ContextBreakdownPanel,
// share cards) cannot use @supports — they route their oklch() colors through
// here instead. Modern engines keep oklch() unchanged (visuals identical);
// older ones get an equivalent sRGB rgb() computed at runtime.

let _supportsOklch = null;

function supportsOklch() {
  if (_supportsOklch === null) {
    try {
      _supportsOklch =
        typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports("color", "oklch(0 0 0)");
    } catch {
      _supportsOklch = false;
    }
  }
  return _supportsOklch;
}

// OKLCH → sRGB. l: 0–1, c: chroma, h: degrees. Returns [r, g, b] in 0–255.
function oklchToSrgb(l, c, h) {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return lin.map((x) => {
    const clamped = Math.min(1, Math.max(0, x));
    const gamma =
      clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(gamma * 255);
  });
}

// oklch() on supporting engines (unchanged), else an equivalent space-separated
// rgb(). Space syntax keeps the `.replace(/\)$/, " / a)")` alpha trick working
// for both forms.
export function oklchColor(l, c, h, alpha) {
  if (supportsOklch()) {
    return alpha == null
      ? `oklch(${l} ${c} ${h})`
      : `oklch(${l} ${c} ${h} / ${alpha})`;
  }
  const [r, g, b] = oklchToSrgb(l, c, h);
  return alpha == null ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

// Convert a static "oklch(L C H)" literal to the fallback form. For module-level
// color constants declared as strings.
export function oklchLiteral(str) {
  const m = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(str);
  if (!m) return str;
  return oklchColor(Number(m[1]), Number(m[2]), Number(m[3]));
}
