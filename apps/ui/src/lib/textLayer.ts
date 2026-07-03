import { scoreGarbledPage, type GarbledPageInfo } from "@raiopdf/rules";
import type { PDFDocumentProxy } from "./pdfjs";

export interface TextLayerCoverage {
  pageCount: number;
  pagesWithText: number[];
  missingTextPages: number[];
  garbledPages: GarbledPageInfo[];
  allPagesHaveText: boolean;
  hasAnyText: boolean;
}

export async function inspectTextLayer(bytes: Uint8Array): Promise<TextLayerCoverage> {
  const { loadPdfDocument } = await import("./pdfjs");
  const pdfDocument = await loadPdfDocument(bytes);

  try {
    return await pdfDocumentTextLayerCoverage(pdfDocument);
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

export async function hasExtractableTextLayer(bytes: Uint8Array): Promise<boolean> {
  return (await inspectTextLayer(bytes)).allPagesHaveText;
}

export async function pdfDocumentTextLayerCoverage(
  pdfDocument: PDFDocumentProxy,
): Promise<TextLayerCoverage> {
  const pagesWithText: number[] = [];
  const missingTextPages: number[] = [];
  const garbledPages: GarbledPageInfo[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => "str" in item ? item.str : "").join(" ");
    const garbleInfo = scoreGarbledPage(pageText, pageNumber - 1);
    if (garbleInfo) {
      garbledPages.push(garbleInfo);
    }

    if (pageText.trim().length > 0) {
      pagesWithText.push(pageNumber);
    } else {
      missingTextPages.push(pageNumber);
    }
  }

  return {
    pageCount: pdfDocument.numPages,
    pagesWithText,
    missingTextPages,
    garbledPages,
    allPagesHaveText: pdfDocument.numPages > 0 && missingTextPages.length === 0,
    hasAnyText: pagesWithText.length > 0,
  };
}

export async function pdfDocumentHasTextLayer(
  pdfDocument: PDFDocumentProxy,
): Promise<boolean> {
  return (await pdfDocumentTextLayerCoverage(pdfDocument)).allPagesHaveText;
}
