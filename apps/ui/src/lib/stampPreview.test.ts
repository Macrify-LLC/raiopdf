import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PDFFont } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfTextMeasureFont } from "@raiopdf/engine-api";
import { sanitizeIndexTextForFont } from "@raiopdf/engine-local";
import { computeStampPreviewLayout, MIN_STAMP_FONT_SIZE_PT } from "./stampPreview";

async function embeddedHelvetica(): Promise<PDFFont> {
  const doc = await PDFDocument.create();
  return doc.embedFont(StandardFonts.Helvetica);
}

/** A font that throws when asked to measure more than one character at once. */
function throwsOnMultiCharFont(): PdfTextMeasureFont {
  return {
    widthOfTextAtSize(text: string, size: number): number {
      if (text.length > 1) {
        throw new Error("this font refuses to measure more than one character at a time");
      }
      return size * 0.5;
    },
  };
}

describe("computeStampPreviewLayout", () => {
  it("does not throw when a label contains characters the font can't encode", async () => {
    const font = await embeddedHelvetica();

    expect(() =>
      computeStampPreviewLayout({
        lines: ["Plaintiff's Exhibit \u{1F600} A"],
        widthPt: 115.2,
        heightPt: 72,
        fontSizePt: 14,
        borderWidthPt: 1,
        cornerRadiusPt: 4,
        hasBorder: true,
        font,
      }),
    ).not.toThrow();
  });

  it("sanitizes a label the same way the engine does before saving", async () => {
    const font = await embeddedHelvetica();
    const rawLine = "Plaintiff's Exhibit \u{1F600} A";

    const layout = computeStampPreviewLayout({
      lines: [rawLine],
      widthPt: 300,
      heightPt: 100,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font,
    });

    // The engine's own sanitizer (packages/engine-local/src/textFit.ts) is
    // what actually runs before the saved PDF draws this line — the preview
    // must land on exactly the same text.
    expect(layout.lines).toEqual([sanitizeIndexTextForFont(font, rawLine)]);
    expect(layout.lines[0]).toBe("Plaintiff's Exhibit A");
  });

  it("falls back to an approximate width instead of throwing when measurement itself throws", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 200,
      heightPt: 100,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font: throwsOnMultiCharFont(),
    });

    expect(layout.lines).toEqual(["Exhibit A"]);
    expect(layout.fontSizePt).toBeGreaterThanOrEqual(MIN_STAMP_FONT_SIZE_PT);
  });
});
