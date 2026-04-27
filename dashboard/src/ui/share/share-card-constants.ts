export const DEFAULT_SHARE_CARD_VARIANT = "annual-report";
export const IDENTITY_CARD_VARIANT = "identity-card";
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 1630;
export const IDENTITY_CARD_SURFACE_WIDTH = 1200;
export const IDENTITY_CARD_SURFACE_HEIGHT = 688;
export const IDENTITY_CARD_FRAME_PADDING = 0;
export const IDENTITY_CARD_WIDTH = IDENTITY_CARD_SURFACE_WIDTH;
export const IDENTITY_CARD_HEIGHT = IDENTITY_CARD_SURFACE_HEIGHT;

export const VARIANT_SIZES: Record<string, { width: number; height: number }> = {
  broadsheet: { width: 1200, height: 1630 },
  "annual-report": { width: 1080, height: 1865 },
  [IDENTITY_CARD_VARIANT]: { width: IDENTITY_CARD_WIDTH, height: IDENTITY_CARD_HEIGHT },
};
