import { loadPdfDocument, type PDFDocumentProxy } from "./pdfjs";

const DEFAULT_TEXT_PROBE_PAGES = 5;

export async function hasExtractableTextLayer(
  bytes: Uint8Array,
  maxPages = DEFAULT_TEXT_PROBE_PAGES,
): Promise<boolean> {
  const pdfDocument = await loadPdfDocument(bytes);

  try {
    return await pdfDocumentHasTextLayer(pdfDocument, maxPages);
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

export async function pdfDocumentHasTextLayer(
  pdfDocument: PDFDocumentProxy,
  maxPages = DEFAULT_TEXT_PROBE_PAGES,
): Promise<boolean> {
  const pageLimit = Math.min(maxPages, pdfDocument.numPages);

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();

    if (
      textContent.items.some((item) => {
        return "str" in item && item.str.trim().length > 0;
      })
    ) {
      return true;
    }
  }

  return false;
}
