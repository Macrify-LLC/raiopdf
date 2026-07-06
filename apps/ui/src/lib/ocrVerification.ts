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
      trivialTextImagePages: number;
      message: string;
    }
  | {
      status: "failed";
      garbledPages: number;
      imageOnlyPages: number;
      trivialTextImagePages: number;
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
  const trivialTextImagePages = coverage.trivialTextImagePages?.length ?? 0;

  if (pageCount <= 0) {
    return {
      status: "failed",
      garbledPages,
      imageOnlyPages,
      trivialTextImagePages,
      message: "OCR produced an empty document — the original was kept unchanged.",
    };
  }

  if (garbledPages === 0 && imageOnlyPages === 0 && trivialTextImagePages === 0) {
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
      ...(coverage.trivialTextImagePages?.map((page) => page.pageIndex) ?? []),
    ]).size;

    return {
      status: "warning",
      pageCount,
      rebuiltPages: pageCount,
      garbledPages,
      imageOnlyPages,
      trivialTextImagePages,
      message: `Rebuilt the text layer on ${formatPageCount(pageCount)}. Warning: ${formatPageCount(imperfectPages)} may still have imperfect text. Copy, paste, and search should work better, but review the affected pages before relying on the text.`,
    };
  }

  if (trivialTextImagePages > 0) {
    const affectedPages = coverage.trivialTextImagePages
      ?.map((page) => page.pageIndex)
      .sort((a, b) => a - b) ?? [];
    return {
      status: "failed",
      garbledPages,
      imageOnlyPages,
      trivialTextImagePages,
      message: `Normal OCR may have skipped ${formatPageIndexes(affectedPages)} because ${trivialTextImagePages === 1 ? "it already has" : "they already have"} a tiny text layer over a scanned page image. The original was kept unchanged. Run Force OCR to rebuild every page's text layer.`,
    };
  }

  if (garbledPages > 0) {
    return {
      status: "failed",
      garbledPages,
      imageOnlyPages,
      trivialTextImagePages,
      message: `Re-OCR ran, but ${formatPageCount(garbledPages)} still ${garbledPages === 1 ? "looks" : "look"} garbled${imageOnlyPages > 0 ? ` and ${formatPageCount(imageOnlyPages)} still ${imageOnlyPages === 1 ? "has" : "have"} no searchable text` : ""} — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
    };
  }

  return {
    status: "failed",
    garbledPages,
    imageOnlyPages,
    trivialTextImagePages,
    message: `OCR ran, but ${formatPageCount(imageOnlyPages)} still ${imageOnlyPages === 1 ? "has" : "have"} no searchable text — the original was kept unchanged; the underlying scan is likely too low-quality to read.`,
  };
}

function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

function formatPageIndexes(pageIndexes: readonly number[]): string {
  const pages = [...new Set(pageIndexes)].map((pageIndex) => pageIndex + 1);

  if (pages.length === 0) {
    return "the affected pages";
  }

  if (pages.length === 1) {
    return `page ${pages[0]}`;
  }

  if (pages.length === 2) {
    return `pages ${pages[0]} and ${pages[1]}`;
  }

  return `pages ${pages.slice(0, -1).join(", ")}, and ${pages[pages.length - 1]}`;
}
