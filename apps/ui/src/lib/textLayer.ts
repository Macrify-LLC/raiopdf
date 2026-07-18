import {
  scoreGarbledPage,
  type TextLayerCoverage,
  type TrivialTextImagePageInfo,
} from "@raiopdf/rules";
import type { PDFDocumentProxy } from "./pdfjs";
import { getPdfPageTextContent } from "./pdfTextContent";

const PDFJS_SAVE_OPERATOR = 10;
const PDFJS_RESTORE_OPERATOR = 11;
const PDFJS_TRANSFORM_OPERATOR = 12;
const PDFJS_IMAGE_OPERATORS = new Set([
  83, // paintImageMaskXObject
  84, // paintImageMaskXObjectGroup
  85, // paintImageXObject
  86, // paintInlineImageXObject
  87, // paintInlineImageXObjectGroup
  88, // paintImageXObjectRepeat
  89, // paintImageMaskXObjectRepeat
]);
const TRIVIAL_TEXT_IMAGE_MAX_CHARS = 40;
const LARGE_IMAGE_COVERAGE_MIN_RATIO = 0.65;

type PdfOperatorList = {
  fnArray: readonly number[];
  argsArray?: readonly unknown[];
};

type Matrix = [number, number, number, number, number, number];

export async function inspectTextLayer(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null = null,
): Promise<TextLayerCoverage> {
  return withPdfDocument(bytes, currentPdfDocument, pdfDocumentTextLayerCoverage);
}

export async function hasExtractableTextLayer(
  bytes: Uint8Array,
  currentPdfDocument: PDFDocumentProxy | null = null,
): Promise<boolean> {
  return hasSearchableTextLayerCoverage(await inspectTextLayer(bytes, currentPdfDocument));
}

export async function inspectOpenTextLayerCoverage({
  bytes,
  pdfDocument,
  streamed,
}: {
  bytes: Uint8Array | null;
  pdfDocument: PDFDocumentProxy;
  streamed: boolean;
}): Promise<TextLayerCoverage | null> {
  if (bytes) {
    return inspectTextLayer(bytes, pdfDocument);
  }

  if (streamed) {
    return null;
  }

  return null;
}

export async function pdfDocumentTextLayerCoverage(
  pdfDocument: PDFDocumentProxy,
): Promise<TextLayerCoverage> {
  const imageOnlyPages: number[] = [];
  const mixedPages: number[] = [];
  const textPages: number[] = [];
  const garbledPages: TextLayerCoverage["garbledPages"][number][] = [];
  const trivialTextImagePages: TrivialTextImagePageInfo[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await getPdfPageTextContent(page);
    const pageText = content.items.map(textItemString).join(" ");
    const hasText = pageText.trim().length > 0;
    const operatorList = await page.getOperatorList();
    const imageCoverageRatio = estimateImageCoverageRatio(operatorList, page);
    const hasImage = imageCoverageRatio > 0 || operatorList.fnArray.some(isImageOperator);
    const pageIndex = pageNumber - 1;
    const garbleInfo = scoreGarbledPage(pageText, pageIndex);
    if (garbleInfo) {
      garbledPages.push(garbleInfo);
    }
    const trivialTextImagePage = detectTrivialTextImagePage({
      pageIndex,
      text: pageText,
      hasImage,
      imageCoverageRatio,
    });
    if (trivialTextImagePage) {
      trivialTextImagePages.push(trivialTextImagePage);
    }

    if (!hasText) {
      imageOnlyPages.push(pageIndex);
    } else if (hasImage) {
      mixedPages.push(pageIndex);
    } else {
      textPages.push(pageIndex);
    }
  }

  return { imageOnlyPages, mixedPages, textPages, garbledPages, trivialTextImagePages };
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
  return textLayerCoveragePageCount(coverage) > 0 &&
    coverage.imageOnlyPages.length === 0 &&
    (coverage.trivialTextImagePages?.length ?? 0) === 0;
}

export function detectTrivialTextImagePage({
  pageIndex,
  text,
  hasImage,
  imageCoverageRatio,
}: {
  pageIndex: number;
  text: string;
  hasImage: boolean;
  imageCoverageRatio: number;
}): TrivialTextImagePageInfo | null {
  const textCharacterCount = searchableTextCharacterCount(text);
  if (
    !hasImage ||
    imageCoverageRatio < LARGE_IMAGE_COVERAGE_MIN_RATIO ||
    textCharacterCount === 0 ||
    textCharacterCount > TRIVIAL_TEXT_IMAGE_MAX_CHARS
  ) {
    return null;
  }

  return {
    pageIndex,
    textCharacterCount,
    imageCoverageRatio,
  };
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

function searchableTextCharacterCount(text: string): number {
  return text.normalize("NFKC").match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function estimateImageCoverageRatio(operatorList: PdfOperatorList, page: unknown): number {
  const pageSize = pageViewportSize(page);
  if (!pageSize) {
    return 0;
  }

  const pageArea = pageSize.width * pageSize.height;
  if (pageArea <= 0) {
    return 0;
  }

  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let coveredArea = 0;

  for (const [index, fn] of operatorList.fnArray.entries()) {
    if (fn === PDFJS_SAVE_OPERATOR) {
      stack.push([...matrix]);
      continue;
    }

    if (fn === PDFJS_RESTORE_OPERATOR) {
      matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }

    if (fn === PDFJS_TRANSFORM_OPERATOR) {
      const transform = readMatrix(operatorList.argsArray?.[index]);
      if (transform) {
        matrix = multiplyMatrices(matrix, transform);
      }
      continue;
    }

    if (isImageOperator(fn)) {
      const imageArea = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
      if (Number.isFinite(imageArea) && imageArea > 0) {
        coveredArea = Math.min(pageArea, coveredArea + Math.min(imageArea, pageArea));
      }
    }
  }

  return Math.min(1, Math.max(0, coveredArea / pageArea));
}

function pageViewportSize(page: unknown): { width: number; height: number } | null {
  const getViewport = (page as { getViewport?: unknown })?.getViewport;
  if (typeof getViewport !== "function") {
    return null;
  }

  const viewport = getViewport.call(page, { scale: 1 }) as { width?: unknown; height?: unknown };
  const width = finitePositive(viewport.width);
  const height = finitePositive(viewport.height);
  return width !== null && height !== null ? { width, height } : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readMatrix(value: unknown): Matrix | null {
  const values = Array.isArray(value)
    ? value
    : isArrayLikeView(value)
      ? Array.from(value)
      : null;
  if (!values || values.length < 6) {
    return null;
  }

  const matrix = values.slice(0, 6);
  return matrix.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? matrix as Matrix
    : null;
}

function isArrayLikeView(value: unknown): value is ArrayLike<unknown> {
  return ArrayBuffer.isView(value) &&
    typeof (value as { length?: unknown }).length === "number";
}

function multiplyMatrices(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}
