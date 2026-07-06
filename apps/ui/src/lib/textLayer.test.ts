import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "./pdfjs";
import {
  hasSearchableTextLayerCoverage,
  inspectOpenTextLayerCoverage,
  pdfDocumentHasTextLayer,
  pdfDocumentTextLayerCoverage,
} from "./textLayer";

const OPS_TRANSFORM = 12;
const OPS_PAINT_IMAGE = 85;

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

  it("flags a tiny text layer over a full-page image as effectively unsearchable", async () => {
    const document = fakePdfDocument([
      {
        text: "EXHIBIT B",
        fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE],
        argsArray: [[612, 0, 0, 792, 0, 0], ["img-1"]],
      },
      "searchable body text",
    ]);

    const coverage = await pdfDocumentTextLayerCoverage(document);

    expect(hasSearchableTextLayerCoverage(coverage)).toBe(false);
    expect(coverage).toMatchObject({
      imageOnlyPages: [],
      mixedPages: [0],
      textPages: [1],
      garbledPages: [],
      trivialTextImagePages: [{
        pageIndex: 0,
        textCharacterCount: 8,
        imageCoverageRatio: 1,
      }],
    });
  });

  it("does not flag short text when the image does not cover most of the page", async () => {
    const document = fakePdfDocument([
      {
        text: "EXHIBIT B",
        fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE],
        argsArray: [[72, 0, 0, 72, 72, 620], ["img-1"]],
      },
    ]);

    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      imageOnlyPages: [],
      mixedPages: [0],
      textPages: [],
      garbledPages: [],
      trivialTextImagePages: [],
    });
  });

  it("does not flag a full-page image when the text layer has substantive text", async () => {
    const document = fakePdfDocument([
      {
        text: "This page has enough searchable text to behave like an OCR result, even though it also has a full-page image.",
        fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE],
        argsArray: [[612, 0, 0, 792, 0, 0], ["img-1"]],
      },
    ]);

    await expect(pdfDocumentTextLayerCoverage(document)).resolves.toMatchObject({
      imageOnlyPages: [],
      mixedPages: [0],
      textPages: [],
      garbledPages: [],
      trivialTextImagePages: [],
    });
  });

  it("leaves streamed document coverage lazy at open", async () => {
    const document = fakePdfDocument(["page one", "page two"]);

    await expect(inspectOpenTextLayerCoverage({
      bytes: null,
      pdfDocument: document,
      streamed: true,
    })).resolves.toBeNull();
    expect(document.getPage).not.toHaveBeenCalled();
  });
});

type FakePage = string | {
  text: string;
  fnArray?: readonly number[];
  argsArray?: readonly unknown[];
  width?: number;
  height?: number;
};

function fakePdfDocument(pages: readonly FakePage[]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (pageNumber: number) => {
      const page = normalizeFakePage(pages[pageNumber - 1]);
      return {
        getTextContent: async () => ({
          items: page.text.length > 0 ? [{ str: page.text }] : [],
        }),
        getOperatorList: async () => ({
          fnArray: page.fnArray,
          argsArray: page.argsArray,
        }),
        getViewport: () => ({
          width: page.width,
          height: page.height,
        }),
      };
    }),
  } as unknown as PDFDocumentProxy;
}

function normalizeFakePage(page: FakePage | undefined): Required<Omit<Exclude<FakePage, string>, "argsArray">> & {
  argsArray: readonly unknown[];
} {
  if (typeof page === "string" || page === undefined) {
    return {
      text: page ?? "",
      fnArray: [],
      argsArray: [],
      width: 612,
      height: 792,
    };
  }

  return {
    text: page.text,
    fnArray: page.fnArray ?? [],
    argsArray: page.argsArray ?? [],
    width: page.width ?? 612,
    height: page.height ?? 792,
  };
}
