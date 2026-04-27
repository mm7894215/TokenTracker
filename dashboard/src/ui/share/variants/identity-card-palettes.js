const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };
const SLATE = { r: 100, g: 116, b: 139 };

const SHARE_CARD_GRADIENTS = [
  { from: [5, 150, 105], to: [52, 211, 153] },
  { from: [29, 78, 216], to: [96, 165, 250] },
  { from: [67, 56, 202], to: [129, 140, 248] },
  { from: [51, 65, 85], to: [148, 163, 184] },
  { from: [194, 65, 12], to: [251, 146, 60] },
  { from: [15, 118, 110], to: [45, 212, 191] },
  { from: [190, 18, 60], to: [251, 113, 133] },
  { from: [3, 105, 161], to: [56, 189, 248] },
  { from: [109, 40, 217], to: [167, 139, 250] },
  { from: [87, 83, 78], to: [168, 162, 158] },
];

function hashSeed(seed) {
  const text = String(seed || "identity-card");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickGradient(seed) {
  return SHARE_CARD_GRADIENTS[hashSeed(seed) % SHARE_CARD_GRADIENTS.length];
}

function tupleToRgb(tuple) {
  return {
    r: tuple[0],
    g: tuple[1],
    b: tuple[2],
  };
}

function mixRgb(color, target, colorRatio) {
  const targetRatio = 1 - colorRatio;
  return {
    r: Math.round(color.r * colorRatio + target.r * targetRatio),
    g: Math.round(color.g * colorRatio + target.g * targetRatio),
    b: Math.round(color.b * colorRatio + target.b * targetRatio),
  };
}

function rgb(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function rgba(color, alpha) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function buildDots(fromRgb, toRgb) {
  return [
    rgba(WHITE, 0.2),
    rgba(mixRgb(toRgb, WHITE, 0.28), 0.66),
    rgba(mixRgb(toRgb, WHITE, 0.46), 0.78),
    rgba(mixRgb(toRgb, WHITE, 0.64), 0.9),
    rgba(mixRgb(toRgb, WHITE, 0.82), 1),
  ];
}

export function buildPalette(seed) {
  const gradient = pickGradient(seed);
  const fromRgb = tupleToRgb(gradient.from);
  const toRgb = tupleToRgb(gradient.to);
  return {
    cardBg: `linear-gradient(145deg, ${rgb(fromRgb)} 0%, ${rgb(toRgb)} 100%)`,
    halo: `radial-gradient(circle at 88% 82%, ${rgba(toRgb, 0.62)}, ${rgba(toRgb, 0)} 32%)`,
    pageBg: rgb(mixRgb(fromRgb, WHITE, 0.05)),
    ink: rgb(mixRgb(fromRgb, BLACK, 0.42)),
    muted: rgb(mixRgb(fromRgb, SLATE, 0.26)),
    label: rgb(mixRgb(fromRgb, SLATE, 0.34)),
    rule: rgb(mixRgb(fromRgb, WHITE, 0.16)),
    panel: rgba(WHITE, 0.82),
    panelSoft: rgba(WHITE, 0.58),
    cardShadow: "0 18px 44px rgba(15, 23, 42, 0.08)",
    panelShadow: "0 10px 26px rgba(15, 23, 42, 0.04)",
    dotGlow: `0 0 24px ${rgba(toRgb, 0.34)}`,
    dots: buildDots(fromRgb, toRgb),
  };
}
