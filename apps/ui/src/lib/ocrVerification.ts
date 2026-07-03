import type { TextLayerCoverage } from "./textLayer";

export type OcrVerificationResult =
  | {
      status: "verified";
      pageCount: number;
      rebuiltPages: number;
      message: string;
    }
  | {
      status: "failed";
      garbledPages: number;
      missingTextPages: number;
      message: string;
    };

export function verifyOcrTextLayer(coverage: TextLayerCoverage): OcrVerificationResult {
  const garbledPages = coverage.garbledPages.length;
  const missingTextPages = coverage.missingTextPages.length;

  if (coverage.pageCount <= 0) {
    return {
      status: "failed",
      garbledPages,
      missingTextPages,
      message: "OCR produced an empty document — the original was kept unchanged.",
    };
  }

  if (garbledPages === 0 && missingTextPages === 0) {
    return {
      status: "verified",
      pageCount: coverage.pageCount,
      rebuiltPages: coverage.pageCount,
      message: `Rebuilt the text layer on ${formatPageCount(coverage.pageCount)}. Copy, paste, and search now return real text. Verified: all ${formatPageCount(coverage.pageCount)} now ${coverage.pageCount === 1 ? "has" : "have"} clean searchable text.`,
    };
  }

  if (garbledPages > 0) {
    return {
      status: "failed",
      garbledPages,
      missingTextPages,
      message: `Re-OCR ran, but ${formatPageCount(garbledPages)} still ${garbledPages === 1 ? "looks" : "look"} garbled${missingTextPages > 0 ? ` and ${formatPageCount(missingTextPages)} still ${missingTextPages === 1 ? "has" : "have"} no searchable text` : ""} — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
    };
  }

  return {
    status: "failed",
    garbledPages,
    missingTextPages,
    message: `OCR ran, but ${formatPageCount(missingTextPages)} still ${missingTextPages === 1 ? "has" : "have"} no searchable text — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
  };
}

function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}
