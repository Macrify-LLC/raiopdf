import type { PDFPageProxy } from "./pdfjs";

type PdfTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type PdfTextContentParams = Parameters<PDFPageProxy["getTextContent"]>[0];

/**
 * PDF.js 6 implements `getTextContent()` with `for await...of` over a
 * ReadableStream. Some WKWebView releases expose `getReader()` but not the
 * stream's async iterator. Reader-based consumption works in both runtimes.
 */
export async function getPdfPageTextContent(
  page: PDFPageProxy,
  params: PdfTextContentParams = {},
): Promise<PdfTextContent> {
  // Lightweight page doubles used by callers may expose only the public
  // convenience method. Real PDFPageProxy instances always expose the stream.
  if (typeof page.streamTextContent !== "function") {
    return page.getTextContent(params);
  }

  const reader = page.streamTextContent(params).getReader();
  const textContent: PdfTextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return textContent;
      }

      textContent.lang ??= value.lang;
      Object.assign(textContent.styles, value.styles);
      textContent.items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
}
