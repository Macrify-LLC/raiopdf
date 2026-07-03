import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "./pdfjs";
import { findTextRedactionAreas, scanSensitivePatterns } from "./legalTools";

describe("legalTools", () => {
  it("finds SSNs split across pdf.js text items with space separators", async () => {
    const pdf = mockPdf([
      textItem("Client SSN ", 10, 50),
      textItem("123", 70, 18),
      textItem(" ", 88, 4),
      textItem("45", 92, 12),
      textItem(" ", 104, 4),
      textItem("6789", 108, 24),
    ]);

    const hits = await scanSensitivePatterns(pdf);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      category: "SSN",
      confidence: "high",
      excerpt: expect.stringContaining("6789"),
      pageIndex: 0,
    });
    expect(hits[0]?.area.x).toBeLessThanOrEqual(68);
    expect(hits[0]?.area.w).toBeGreaterThan(55);
  });

  it("flags bare 9-digit SSNs as lower confidence", async () => {
    const pdf = mockPdf([
      textItem("Possible SSN 123456789", 10, 120),
    ]);

    const hits = await scanSensitivePatterns(pdf);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      category: "SSN",
      confidence: "lower",
    });
  });

  it("maps text redaction search matches that cross item boundaries", async () => {
    const pdf = mockPdf([
      textItem("Privileged ", 10, 58),
      textItem("matter", 68, 32),
    ]);

    const areas = await findTextRedactionAreas(pdf, "privileged matter");

    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ pageIndex: 0 });
    expect(areas[0]?.x).toBeLessThanOrEqual(8);
    expect(areas[0]?.w).toBeGreaterThan(90);
  });

  it("finds two-word search matches split across text items without literal spaces", async () => {
    const pdf = mockPdf([
      textItem("two", 10, 18),
      textItem("word", 40, 24),
    ]);

    const areas = await findTextRedactionAreas(pdf, "two word");

    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ pageIndex: 0 });
    expect(areas[0]?.x).toBeLessThanOrEqual(8);
    expect(areas[0]?.w).toBeGreaterThan(55);
  });
});

function mockPdf(items: unknown[]): PDFDocumentProxy {
  return {
    numPages: 1,
    getPage: async () => ({
      getTextContent: async () => ({ items }),
    }),
  } as unknown as PDFDocumentProxy;
}

function textItem(str: string, x: number, width: number) {
  return {
    str,
    transform: [1, 0, 0, 10, x, 100],
    width,
    height: 10,
  };
}
