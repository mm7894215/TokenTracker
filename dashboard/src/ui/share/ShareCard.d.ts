import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { ShareCardData } from "./build-share-card-data";

export const SHARE_CARD_WIDTH: number;
export const SHARE_CARD_HEIGHT: number;
export const VARIANT_SIZES: Record<string, { width: number; height: number }>;
export const SHARE_VARIANTS: Array<{ id: string; labelKey: string }>;

export function getVariantSize(variant: string): { width: number; height: number };
export function getShareVariantLabel(variant: string): string;

export const ShareCard: ForwardRefExoticComponent<
  { data: ShareCardData; variant: string } & RefAttributes<HTMLDivElement>
>;
