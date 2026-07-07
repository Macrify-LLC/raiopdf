import type { PdfCoverStyle } from "@raiopdf/engine-api";
import { drawCoverPage } from "@raiopdf/engine-local";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function generateCoverPdf(input: {
  label: string;
  description?: string | undefined;
  style: PdfCoverStyle;
  pageSize?: [number, number] | undefined;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(input.pageSize ?? [612, 792]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  drawCoverPage(page, { regular, bold }, input);

  return doc.save();
}
