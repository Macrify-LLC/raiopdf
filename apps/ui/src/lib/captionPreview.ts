import type { PdfCoverPageOptions } from "@raiopdf/engine-api";
import { drawCaptionPage } from "@raiopdf/engine-local";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function generateCaptionPdf(
  options: PdfCoverPageOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

  drawCaptionPage(page, { regular, bold }, options);

  return doc.save();
}
