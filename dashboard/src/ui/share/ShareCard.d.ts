import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { ShareCardData } from "./build-share-card-data";

export const SHARE_VARIANTS: Array<{ id: string; labelKey: string }>;

export function getVariantSize(variant: string): { width: number; height: number };
export function getShareVariantLabel(variant: string): string;

export const ShareCard: ForwardRefExoticComponent<
  { data: ShareCardData; variant: string } & RefAttributes<HTMLDivElement>
>;
