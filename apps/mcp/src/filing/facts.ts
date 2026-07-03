import { PDFDocument } from "pdf-lib";
import type { DocumentFacts, PageFacts } from "@raiopdf/rules";
import { extractPageText } from "../redaction/pdfjs-node.js";

const POINTS_PER_INCH = 72;

/**
 * Build the DocumentFacts the rules engine needs, entirely in Node:
 * - page sizes + orientation via pdf-lib
 * - file size from the input bytes
 * - searchable-text via pdf.js text extraction
 *
 * The clerk-stamp-space geometry and PDF/A-compliance facts are intentionally
 * left undefined — they are not reliably derivable in Node here, so the rules
 * engine reports those checks as "unknown" rather than a fabricated result.
 */
export async function buildDocumentFacts(bytes: Uint8Array): Promise<DocumentFacts> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages: PageFacts[] = pdf.getPages().map((page, pageIndex) => {
    // Pass unrounded inches so the rules engine's own tolerance decides pass/fail.
    const widthIn = page.getWidth() / POINTS_PER_INCH;
    const heightIn = page.getHeight() / POINTS_PER_INCH;
    return {
      pageIndex,
      size: { w: widthIn, h: heightIn, in: true },
      orientation: heightIn >= widthIn ? "portrait" : "landscape",
    };
  });

  // Page-body text only — an annotation/sticky note must not make an image-only
  // scan look searchable.
  const text = (await extractPageText(bytes)).trim();

  return {
    pages,
    fileBytes: bytes.length,
    searchableText: text.length > 0,
  };
}
