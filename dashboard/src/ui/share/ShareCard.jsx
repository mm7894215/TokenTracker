import React, { forwardRef } from "react";
import { copy } from "../../lib/copy";
import { BroadsheetCard } from "./variants/BroadsheetCard.jsx";
import { AnnualReportCard } from "./variants/AnnualReportCard.jsx";
import { IdentityCard } from "./variants/IdentityCard.jsx";
import { buildPalette } from "./variants/identity-card-palettes";
import {
  DEFAULT_SHARE_CARD_VARIANT,
  IDENTITY_CARD_VARIANT,
  IDENTITY_CARD_FRAME_PADDING,
  IDENTITY_CARD_HEIGHT,
  IDENTITY_CARD_SURFACE_HEIGHT,
  IDENTITY_CARD_SURFACE_WIDTH,
  IDENTITY_CARD_WIDTH,
  SHARE_CARD_WIDTH,
  SHARE_CARD_HEIGHT,
  VARIANT_SIZES,
} from "./share-card-constants";

export {
  DEFAULT_SHARE_CARD_VARIANT,
  IDENTITY_CARD_VARIANT,
  IDENTITY_CARD_FRAME_PADDING,
  IDENTITY_CARD_HEIGHT,
  IDENTITY_CARD_SURFACE_HEIGHT,
  IDENTITY_CARD_SURFACE_WIDTH,
  IDENTITY_CARD_WIDTH,
  SHARE_CARD_WIDTH,
  SHARE_CARD_HEIGHT,
  VARIANT_SIZES,
};

export const SHARE_VARIANTS = [
  { id: "annual-report", labelKey: "share.variant.neon" },
  { id: "broadsheet", labelKey: "share.variant.broadsheet" },
  { id: IDENTITY_CARD_VARIANT, labelKey: "share.variant.identity" },
];

const VARIANT_MAP = {
  broadsheet: BroadsheetCard,
  "annual-report": AnnualReportCard,
  [IDENTITY_CARD_VARIANT]: IdentityCardFrame,
};

const IDENTITY_SURFACE_RADIUS = 40;
const IDENTITY_SURFACE_SHADOW = "none";

export function getVariantSize(variant = DEFAULT_SHARE_CARD_VARIANT) {
  const s = VARIANT_SIZES[variant];
  return s || { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT };
}

export function getShareVariantLabel(variant) {
  const match = SHARE_VARIANTS.find((item) => item.id === variant);
  if (!match?.labelKey) return variant;
  return copy(match.labelKey);
}

function IdentityCardFrame({ data }) {
  const palette = buildPalette(data?.colorSeed || data?.capturedAt || data?.handle);
  return (
    <div
      data-share-card-surface="true"
      style={{
        width: IDENTITY_CARD_WIDTH,
        height: IDENTITY_CARD_HEIGHT,
        borderRadius: IDENTITY_SURFACE_RADIUS,
        overflow: "hidden",
        boxShadow: IDENTITY_SURFACE_SHADOW,
        border: "1px solid hsl(220 18% 40% / 0.10)",
        background: palette.pageBg,
        boxSizing: "border-box",
      }}
    >
      <IdentityCard data={data} />
    </div>
  );
}

export const ShareCard = forwardRef(function ShareCard(
  { data, variant = DEFAULT_SHARE_CARD_VARIANT },
  ref,
) {
  const resolvedVariant = variant || DEFAULT_SHARE_CARD_VARIANT;
  const CardComponent = VARIANT_MAP[resolvedVariant] || BroadsheetCard;
  const { width, height } = getVariantSize(resolvedVariant);
  return (
    <div
      ref={ref}
      data-share-card="true"
      data-share-variant={resolvedVariant}
      style={{
        width,
        height,
        position: "relative",
        overflow: "hidden",
        boxSizing: "border-box",
        background: "transparent",
      }}
    >
      <CardComponent data={data} />
    </div>
  );
});
