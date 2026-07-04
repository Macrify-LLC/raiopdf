import { PDFDocument } from "pdf-lib";
import { readRaioPdfMarkupAnnotations } from "@raiopdf/engine-local";

export async function countRaioPdfMarkupAnnotations(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);

  return pdf.getPages().reduce(
    (count, page) => count + readRaioPdfMarkupAnnotations(page).length,
    0,
  );
}
