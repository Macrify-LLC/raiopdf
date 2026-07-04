import { scoreGarbledPage, type TextLayerCoverage } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "./pdfjs";

const PDFJS_IMAGE_OPERATORS = new Set([
  83, // paintImageMaskXObject
  84, // paintImageMaskXObjectGroup
  85, // paintImageXObject
  86, // paintInlineImageXObject
  87, // paintInlineImageXObjectGroup
  88, // paintImageXObjectRepeat
  89, // paintImageMaskXObjectRepeat
]);

export async function inspectTextLayer(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null = null,
): Promise<TextLayerCoverage> {
  return withPdfDocument(bytes, currentPdfDocument, pdfDocumentTextLayerCoverage);
}

export async function hasExtractableTextLayer(bytes: Uint8Array): Promise<boolean> {
  return hasSearchableTextLayerCoverage(await inspectTextLayer(bytes));
}

export async function pdfDocumentTextLayerCoverage(
  pdfDocument: PDFDocumentProxy,
): Promise<TextLayerCoverage> {
  const imageOnlyPages: number[] = [];
  const mixedPages: number[] = [];
  const textPages: number[] = [];
  const garbledPages: TextLayerCoverage["garbledPages"][number][] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map(textItemString).join(" ");
    const hasText = pageText.trim().length > 0;
    const operatorList = await page.getOperatorList();
    const hasImage = operatorList.fnArray.some(isImageOperator);
    const pageIndex = pageNumber - 1;
    const garbleInfo = scoreGarbledPage(pageText, pageIndex);
    if (garbleInfo) {
      garbledPages.push(garbleInfo);
    }

    if (!hasText) {
      imageOnlyPages.push(pageIndex);
    } else if (hasImage) {
      mixedPages.push(pageIndex);
    } else {
      textPages.push(pageIndex);
    }
  }

  return { imageOnlyPages, mixedPages, textPages, garbledPages };
}

export async function pdfDocumentHasTextLayer(
  pdfDocument: PDFDocumentProxy,
): Promise<boolean> {
  return hasSearchableTextLayerCoverage(await pdfDocumentTextLayerCoverage(pdfDocument));
}

export function textLayerCoveragePageCount(coverage: TextLayerCoverage): number {
  return coverage.imageOnlyPages.length + coverage.mixedPages.length + coverage.textPages.length;
}

export function hasSearchableTextLayerCoverage(coverage: TextLayerCoverage): boolean {
  return textLayerCoveragePageCount(coverage) > 0 && coverage.imageOnlyPages.length === 0;
}

async function withPdfDocument<T>(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null,
  read: (pdfDocument: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  if (currentPdfDocument) {
    return read(currentPdfDocument);
  }

  const { loadPdfDocument } = await import("./pdfjs");
  const pdfDocument = await loadPdfDocument(bytes);

  try {
    return await read(pdfDocument);
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

function textItemString(item: unknown): string {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return "";
  }

  const { str } = item as { str?: unknown };
  return typeof str === "string" ? str : "";
}

function isImageOperator(fn: number): boolean {
  return PDFJS_IMAGE_OPERATORS.has(fn);
}
