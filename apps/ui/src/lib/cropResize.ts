import type { PdfPageSizePoints } from "@raiopdf/engine-api";

const POINTS_PER_INCH = 72;

export type ResizePreset = "original" | "letter" | "legal";

export const RESIZE_PRESET_SIZES: Record<
  Exclude<ResizePreset, "original">,
  PdfPageSizePoints
> = {
  letter: { widthPt: 8.5 * POINTS_PER_INCH, heightPt: 11 * POINTS_PER_INCH },
  legal: { widthPt: 8.5 * POINTS_PER_INCH, heightPt: 14 * POINTS_PER_INCH },
};
