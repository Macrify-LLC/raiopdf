import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { PdfTextBoxFontFamily } from "@raiopdf/engine-api";

/**
 * Standard-font loading for on-screen previews.
 *
 * The overlay has to wrap and shrink text exactly the way the engine will when
 * it bakes the edit, so previews measure with the same pdf-lib standard fonts
 * the engine draws with rather than with browser text metrics. Fonts are
 * cached per family/weight for the life of the session — embedding one is
 * cheap but not free, and every text box, callout, and stamp on screen wants
 * the same handful.
 */

export type PreviewFontKey =
  `${PdfTextBoxFontFamily}:${"regular" | "bold" | "italic" | "boldItalic"}`;

const PREVIEW_STANDARD_FONTS: Record<PreviewFontKey, StandardFonts> = {
  "helvetica:regular": StandardFonts.Helvetica,
  "helvetica:bold": StandardFonts.HelveticaBold,
  "helvetica:italic": StandardFonts.HelveticaOblique,
  "helvetica:boldItalic": StandardFonts.HelveticaBoldOblique,
  "times:regular": StandardFonts.TimesRoman,
  "times:bold": StandardFonts.TimesRomanBold,
  "times:italic": StandardFonts.TimesRomanItalic,
  "times:boldItalic": StandardFonts.TimesRomanBoldItalic,
  "courier:regular": StandardFonts.Courier,
  "courier:bold": StandardFonts.CourierBold,
  "courier:italic": StandardFonts.CourierOblique,
  "courier:boldItalic": StandardFonts.CourierBoldOblique,
};

const previewFontCache = new Map<PreviewFontKey, Promise<PDFFont>>();

export function previewFontKey(
  fontFamily: PdfTextBoxFontFamily,
  bold: boolean,
  italic: boolean,
): PreviewFontKey {
  if (bold && italic) {
    return `${fontFamily}:boldItalic`;
  }

  if (bold) {
    return `${fontFamily}:bold`;
  }

  if (italic) {
    return `${fontFamily}:italic`;
  }

  return `${fontFamily}:regular`;
}

export function loadPreviewFont(key: PreviewFontKey): Promise<PDFFont> {
  let font = previewFontCache.get(key);

  if (!font) {
    font = PDFDocument.create().then((pdf) => pdf.embedFont(PREVIEW_STANDARD_FONTS[key]));
    previewFontCache.set(key, font);
  }

  return font;
}

/** The CSS stack that visually matches each standard PDF font family. */
export function cssTextBoxFontFamily(fontFamily: PdfTextBoxFontFamily): string {
  switch (fontFamily) {
    case "times":
      return '"Times New Roman", Times, serif';
    case "courier":
      return '"Courier New", Courier, monospace';
    case "helvetica":
      return "Helvetica, Arial, sans-serif";
  }
}
