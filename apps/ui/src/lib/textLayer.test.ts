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
      imageOnlyPages: [1],
      mixedPages: [],
      textPages: [0, 2],
      garbledPages: [],
    });
  });

  it("reports verified only when all pages have text", async () => {
    const document = fakePdfDocument(["one", "two"]);

    await expect(pdfDocumentHasTextLayer(document)).resolves.toBe(true);
    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [0, 1],
      garbledPages: [],
    });
  });

  it("does not treat an empty document as verified searchable", async () => {
    const document = fakePdfDocument([]);

    await expect(pdfDocumentHasTextLayer(document)).resolves.toBe(false);
    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      imageOnlyPages: [],
      mixedPages: [],
      textPages: [],
      garbledPages: [],
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
        getOperatorList: async () => ({
          fnArray: [],
        }),
      };
    },
  } as unknown as PDFDocumentProxy;
}
