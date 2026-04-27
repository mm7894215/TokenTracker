type SharePreviewScaleParams = {
  cardWidth: number;
  cardHeight: number;
  maxWidth: number;
  maxHeight: number;
};

function normalizeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getSharePreviewScale({
  cardWidth,
  cardHeight,
  maxWidth,
  maxHeight,
}: SharePreviewScaleParams): number {
  const safeCardWidth = normalizeSize(cardWidth);
  const safeCardHeight = normalizeSize(cardHeight);
  const safeMaxWidth = normalizeSize(maxWidth);
  const safeMaxHeight = normalizeSize(maxHeight);
  if (!safeCardWidth || !safeCardHeight || !safeMaxWidth || !safeMaxHeight) return 1;
  return Math.min(safeMaxWidth / safeCardWidth, safeMaxHeight / safeCardHeight, 1);
}
