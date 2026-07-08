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

export interface FilingOcrOutputPart {
  bytes: Uint8Array;
  fileName: string;
}

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

// Advisory only: describes an imperfect OCR result so the filing output can carry
// the warning, never to block the save. Filing rules — and the quality checks that
// gate them — are advisory; the user is always in charge of producing the file.
export function filingOcrVerificationNotice(result: OcrVerificationResult): string | null {
  if (result.status === "verified") {
    return null;
  }

  const issueSummary = formatIssueSummary(result);
  const prefix = result.status === "warning"
    ? "OCR finished, but the filing copy still has imperfect searchable text."
    : "OCR ran, but the filing copy is still not fully searchable.";

  return `${prefix} ${issueSummary} Review the affected pages before relying on the text.`;
}

// Returns one advisory notice per output part that isn't cleanly searchable (empty
// array when every part is verified). Never throws on a quality failure — an
// unverifiable part becomes a notice too, so the save still proceeds.
export async function collectFilingOcrOutputPartNotices(
  parts: readonly FilingOcrOutputPart[],
  mode: OcrVerificationMode,
  inspectPartTextLayer: (bytes: Uint8Array) => Promise<TextLayerCoverage>,
): Promise<string[]> {
  const notices: string[] = [];

  for (const part of parts) {
    let coverage: TextLayerCoverage;
    try {
      coverage = await inspectPartTextLayer(part.bytes);
    } catch {
      notices.push(`${part.fileName}: The filing copy text layer could not be verified.`);
      continue;
    }

    const notice = filingOcrVerificationNotice(verifyOcrTextLayer(coverage, mode));
    if (notice) {
      notices.push(`${part.fileName}: ${notice}`);
    }
  }

  return notices;
}

function formatIssueSummary({
  garbledPages,
  imageOnlyPages,
  trivialTextImagePages,
}: {
  garbledPages: number;
  imageOnlyPages: number;
  trivialTextImagePages: number;
}): string {
  const issues: string[] = [];

  if (imageOnlyPages > 0) {
    issues.push(`${formatPageCount(imageOnlyPages)} still ${imageOnlyPages === 1 ? "has" : "have"} no searchable text`);
  }

  if (garbledPages > 0) {
    issues.push(`${formatPageCount(garbledPages)} still ${garbledPages === 1 ? "has" : "have"} garbled text`);
  }

  if (trivialTextImagePages > 0) {
    issues.push(`${formatPageCount(trivialTextImagePages)} still ${trivialTextImagePages === 1 ? "has" : "have"} only a tiny text layer over scanned page images`);
  }

  return issues.length > 0
    ? `${formatList(issues)}.`
    : "The text layer could not be verified.";
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0] ?? "";
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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
