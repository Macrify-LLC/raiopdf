import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "./pdfjs";
import {
  pdfDocumentHasTextLayer,
  pdfDocumentTextLayerCoverage,
} from "./textLayer";

describe("pdfDocumentTextLayerCoverage", () => {
  it("requires every page to have extractable text before reporting verified", async () => {
    const document = fakePdfDocument(["page one text", "", "page three text"]);

    await expect(pdfDocumentHasTextLayer(document)).resolves.toBe(false);
    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      pageCount: 3,
      pagesWithText: [1, 3],
      missingTextPages: [2],
      allPagesHaveText: false,
      hasAnyText: true,
    });
  });

  it("reports verified only when all pages have text", async () => {
    const document = fakePdfDocument(["one", "two"]);

    await expect(pdfDocumentHasTextLayer(document)).resolves.toBe(true);
    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      pageCount: 2,
      pagesWithText: [1, 2],
      missingTextPages: [],
      allPagesHaveText: true,
      hasAnyText: true,
    });
  });

  it("does not treat an empty document as verified searchable", async () => {
    const document = fakePdfDocument([]);

    await expect(pdfDocumentHasTextLayer(document)).resolves.toBe(false);
    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      pageCount: 0,
      pagesWithText: [],
      missingTextPages: [],
      allPagesHaveText: false,
      hasAnyText: false,
    });
  });
});

function fakePdfDocument(pageTexts: readonly string[]): PDFDocumentProxy {
  return {
    numPages: pageTexts.length,
    getPage: async (pageNumber: number) => {
      const text = pageTexts[pageNumber - 1] ?? "";
      return {
        getTextContent: async () => ({
          items: text.length > 0 ? [{ str: text }] : [],
        }),
      };
    },
  } as unknown as PDFDocumentProxy;
}
