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

export function filingOcrVerificationFailureMessage(result: OcrVerificationResult): string | null {
  if (result.status === "verified") {
    return null;
  }

  const issueSummary = formatIssueSummary(result);
  const prefix = result.status === "warning"
    ? "OCR finished, but the filing copy still has imperfect searchable text."
    : "OCR ran, but the filing copy is still not fully searchable.";

  return `${prefix} ${issueSummary} The filing copy was not saved.`;
}

export async function verifyFilingOcrOutputParts(
  parts: readonly FilingOcrOutputPart[],
  mode: OcrVerificationMode,
  inspectPartTextLayer: (bytes: Uint8Array) => Promise<TextLayerCoverage>,
): Promise<void> {
  for (const part of parts) {
    const coverage = await inspectOutputPartTextLayer(part, inspectPartTextLayer);
    const failureMessage = filingOcrVerificationFailureMessage(verifyOcrTextLayer(coverage, mode));

    if (failureMessage) {
      throw new Error(`${part.fileName}: ${failureMessage}`);
    }
  }
}

async function inspectOutputPartTextLayer(
  part: FilingOcrOutputPart,
  inspectPartTextLayer: (bytes: Uint8Array) => Promise<TextLayerCoverage>,
): Promise<TextLayerCoverage> {
  try {
    return await inspectPartTextLayer(part.bytes);
  } catch {
    throw new Error(
      `${part.fileName}: The filing copy text layer could not be verified. The filing copy was not saved.`,
    );
  }
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
