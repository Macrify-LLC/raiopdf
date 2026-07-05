import type { TextLayerCoverage } from "@raiopdf/rules";
import { textLayerCoveragePageCount } from "./textLayer";

export type OcrVerificationResult =
  | {
      status: "verified";
      pageCount: number;
      rebuiltPages: number;
      message: string;
    }
  | {
      status: "warning";
      pageCount: number;
      rebuiltPages: number;
      garbledPages: number;
      imageOnlyPages: number;
      message: string;
    }
  | {
      status: "failed";
      garbledPages: number;
      imageOnlyPages: number;
      message: string;
    };

export type OcrVerificationMode = "skip-text" | "force-ocr";

export function verifyOcrTextLayer(
  coverage: TextLayerCoverage,
  mode: OcrVerificationMode = "skip-text",
): OcrVerificationResult {
  const pageCount = textLayerCoveragePageCount(coverage);
  const garbledPages = coverage.garbledPages.length;
  const imageOnlyPages = coverage.imageOnlyPages.length;

  if (pageCount <= 0) {
    return {
      status: "failed",
      garbledPages,
      imageOnlyPages,
      message: "OCR produced an empty document — the original was kept unchanged.",
    };
  }

  if (garbledPages === 0 && imageOnlyPages === 0) {
    return {
      status: "verified",
      pageCount,
      rebuiltPages: pageCount,
      message: `Rebuilt the text layer on ${formatPageCount(pageCount)}. Copy, paste, and search now return real text. Verified: all ${formatPageCount(pageCount)} now ${pageCount === 1 ? "has" : "have"} clean searchable text.`,
    };
  }

  if (mode === "force-ocr") {
    const imperfectPages = new Set<number>([
      ...coverage.garbledPages.map((page) => page.pageIndex),
      ...coverage.imageOnlyPages,
    ]).size;

    return {
      status: "warning",
      pageCount,
      rebuiltPages: pageCount,
      garbledPages,
      imageOnlyPages,
      message: `Rebuilt the text layer on ${formatPageCount(pageCount)}. Warning: ${formatPageCount(imperfectPages)} may still have imperfect text. Copy, paste, and search should work better, but review the affected pages before relying on the text.`,
    };
  }

  if (garbledPages > 0) {
    return {
      status: "failed",
      garbledPages,
      imageOnlyPages,
      message: `Re-OCR ran, but ${formatPageCount(garbledPages)} still ${garbledPages === 1 ? "looks" : "look"} garbled${imageOnlyPages > 0 ? ` and ${formatPageCount(imageOnlyPages)} still ${imageOnlyPages === 1 ? "has" : "have"} no searchable text` : ""} — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
    };
  }

  return {
    status: "failed",
    garbledPages,
    imageOnlyPages,
    message: `OCR ran, but ${formatPageCount(imageOnlyPages)} still ${imageOnlyPages === 1 ? "has" : "have"} no searchable text — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
  };
}

function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}
