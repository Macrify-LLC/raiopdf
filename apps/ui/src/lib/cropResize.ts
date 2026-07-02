import { PDFDocument } from "pdf-lib";

const POINTS_PER_INCH = 72;

export type ResizePreset = "original" | "letter" | "legal";

const PRESET_SIZES: Record<Exclude<ResizePreset, "original">, [number, number]> = {
  letter: [8.5 * POINTS_PER_INCH, 11 * POINTS_PER_INCH],
  legal: [8.5 * POINTS_PER_INCH, 14 * POINTS_PER_INCH],
};

export async function cropResizePdf(
  bytes: Uint8Array,
  options: {
    pageIndexes: readonly number[];
    cropMarginIn: number;
    resizePreset: ResizePreset;
  },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes);
  const selectedPages = new Set(options.pageIndexes);
  const cropMarginPt = Math.max(0, options.cropMarginIn) * POINTS_PER_INCH;

  pdf.getPages().forEach((page, pageIndex) => {
    if (!selectedPages.has(pageIndex)) {
      return;
    }

    if (cropMarginPt > 0) {
      const width = page.getWidth();
      const height = page.getHeight();
      const maxMargin = Math.min(width, height) / 2 - 1;
      const margin = Math.min(cropMarginPt, Math.max(maxMargin, 0));
      page.setCropBox(margin, margin, width - margin * 2, height - margin * 2);
    }

    if (options.resizePreset !== "original") {
      const [width, height] = PRESET_SIZES[options.resizePreset];
      page.setSize(width, height);
    }
  });

  return pdf.save();
}
