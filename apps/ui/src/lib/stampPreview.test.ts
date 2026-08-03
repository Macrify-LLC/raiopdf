import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PDFFont } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfTextMeasureFont } from "@raiopdf/engine-api";
import { sanitizeIndexTextForFont } from "@raiopdf/engine-local";
import { TEXT_BOX_LINE_HEIGHT } from "./edits";
import {
  computeStampPreviewLayout,
  MIN_STAMP_FONT_SIZE_PT,
  STAMP_TEXT_PADDING_PT,
} from "./stampPreview";

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

/** A font that happily encodes anything, including control characters. */
function encodesAnythingFont(): PdfTextMeasureFont {
  return {
    widthOfTextAtSize(text: string, size: number): number {
      return text.length * size * 0.5;
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

  it("shrinks against the approximate width when measurement throws", () => {
    const line = "Exhibit A";
    const widthPt = 70;
    const borderWidthPt = 1;
    const contentWidthPt = widthPt - (borderWidthPt + STAMP_TEXT_PADDING_PT) * 2;
    // The fallback bills each character at 0.6 x the font size.
    const approximateWidthAt = (fontSizePt: number): number => line.length * fontSizePt * 0.6;

    const layout = computeStampPreviewLayout({
      lines: [line],
      widthPt,
      heightPt: 100,
      fontSizePt: 14,
      borderWidthPt,
      cornerRadiusPt: 0,
      hasBorder: true,
      font: throwsOnMultiCharFont(),
    });

    // A fallback that under-reports (returning 0, say) would leave the label at
    // its requested size and overflow the box, so pin the shrink it drives.
    expect(layout.fontSizePt).toBeLessThan(14);
    expect(approximateWidthAt(layout.fontSizePt)).toBeLessThanOrEqual(contentWidthPt);
    expect(approximateWidthAt(layout.fontSizePt + 0.5)).toBeGreaterThan(contentWidthPt);
  });

  it("collapses whitespace and control characters the same way the engine does", async () => {
    const font = await embeddedHelvetica();
    // Leading, trailing, and doubled whitespace plus a tab: every run collapses
    // to one space and the ends get trimmed. Helvetica can encode neither U+0001
    // nor U+007F, so against a real font the whitespace branch and the control-
    // character branch are indistinguishable — the test below pins the control-
    // character branch on its own, with a font that encodes anything.
    const rawLine = "  Exhibit\tA \u0001 \u007f  filed  ";

    const layout = computeStampPreviewLayout({
      lines: [rawLine],
      widthPt: 400,
      heightPt: 100,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font,
    });

    expect(layout.lines).toEqual([sanitizeIndexTextForFont(font, rawLine)]);
    expect(layout.lines[0]).toBe("Exhibit A filed");
    // Comfortably inside a 400pt box, so nothing shrank on the way.
    expect(layout.fontSizePt).toBe(14);
  });

  it("strips control characters even from a font that can encode them", () => {
    // Control characters are not whitespace, so nothing but the dedicated
    // control-character check keeps them out of a label. A real font hides that
    // check behind its own encoding failure; this stub encodes everything, so a
    // regression there would leave the raw control characters in the preview.
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit\u0001A \u007f filed"],
      widthPt: 400,
      heightPt: 100,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font: encodesAnythingFont(),
    });

    expect(layout.lines).toEqual(["Exhibit A filed"]);
  });

  it("leaves the label at its requested size and untouched while the font is still loading", () => {
    const rawLines = ["Plaintiff's Exhibit \u{1F600} A", "second line", "third line"];

    const layout = computeStampPreviewLayout({
      // Far too small for three 14pt lines: with a font loaded this would
      // shrink to the floor and drop lines. With nothing to measure against,
      // the label has to pass straight through.
      lines: rawLines,
      widthPt: 20,
      heightPt: 20,
      fontSizePt: 14,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font: null,
    });

    expect(layout.fontSizePt).toBe(14);
    expect(layout.lines).toEqual(rawLines);
  });

  it("raises a below-floor requested size to the legibility floor", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 300,
      heightPt: 200,
      // Below the 6pt floor. Asserted on the font-not-loaded path because that
      // is where the start size is returned as-is: once a font is loaded, a
      // below-floor request skips the shrink loop entirely and the fall-through
      // would report the floor whether or not the start size was raised.
      fontSizePt: 2,
      borderWidthPt: 1,
      cornerRadiusPt: 4,
      hasBorder: true,
      font: null,
    });

    expect(layout.fontSizePt).toBe(MIN_STAMP_FONT_SIZE_PT);
  });

  it("shrinks by half-point steps until the widest line fits the content box", async () => {
    const font = await embeddedHelvetica();
    const line = "Defendant's Exhibit 12";
    const widthPt = 100;
    const borderWidthPt = 1;
    const contentWidthPt = widthPt - (borderWidthPt + STAMP_TEXT_PADDING_PT) * 2;

    const layout = computeStampPreviewLayout({
      lines: [line],
      widthPt,
      // Tall enough that only the width can force the shrink.
      heightPt: 200,
      fontSizePt: 14,
      borderWidthPt,
      cornerRadiusPt: 0,
      hasBorder: true,
      font,
    });

    expect(layout.lines).toEqual([line]);
    expect(layout.fontSizePt).toBeLessThan(14);
    expect(layout.fontSizePt).toBeGreaterThan(MIN_STAMP_FONT_SIZE_PT);
    // The largest step that fits: this one does, the next one up does not.
    expect(font.widthOfTextAtSize(line, layout.fontSizePt)).toBeLessThanOrEqual(contentWidthPt);
    expect(font.widthOfTextAtSize(line, layout.fontSizePt + 0.5)).toBeGreaterThan(contentWidthPt);
  });

  it("shrinks by half-point steps until every line fits the content box's height", async () => {
    const font = await embeddedHelvetica();
    const lines = ["Exhibit", "A", "Filed"];
    const heightPt = 30;
    const borderWidthPt = 1;
    const contentHeightPt = heightPt - (borderWidthPt + STAMP_TEXT_PADDING_PT) * 2;

    const layout = computeStampPreviewLayout({
      lines,
      // Wide enough that only the height can force the shrink.
      widthPt: 400,
      heightPt,
      fontSizePt: 14,
      borderWidthPt,
      cornerRadiusPt: 0,
      hasBorder: true,
      font,
    });

    // Shrunk to fit, not truncated — every line survives.
    expect(layout.lines).toEqual(lines);
    expect(layout.fontSizePt).toBeLessThan(14);
    expect(layout.fontSizePt).toBeGreaterThan(MIN_STAMP_FONT_SIZE_PT);
    expect(lines.length * layout.fontSizePt * TEXT_BOX_LINE_HEIGHT).toBeLessThanOrEqual(
      contentHeightPt,
    );
    expect(lines.length * (layout.fontSizePt + 0.5) * TEXT_BOX_LINE_HEIGHT).toBeGreaterThan(
      contentHeightPt,
    );
  });

  it("drops the surplus lines once the label is already at the floor", async () => {
    const font = await embeddedHelvetica();

    const layout = computeStampPreviewLayout({
      lines: ["One", "Two", "Three", "Four", "Five", "Six"],
      widthPt: 400,
      // 26pt less the 2pt padding a side leaves 22pt of content, and a line at
      // the 6pt floor is 7.2pt tall, so only three of the six fit.
      heightPt: 26,
      fontSizePt: 14,
      borderWidthPt: 0,
      cornerRadiusPt: 0,
      hasBorder: false,
      font,
    });

    expect(layout.fontSizePt).toBe(MIN_STAMP_FONT_SIZE_PT);
    expect(layout.lines).toEqual(["One", "Two", "Three"]);
  });

  it("keeps one line even when the content box is too short for any", async () => {
    const font = await embeddedHelvetica();

    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A", "Filed 2026-01-02"],
      widthPt: 200,
      // The 2pt padding a side consumes the whole box, leaving no content
      // height at all — a stamp that previews as nothing would be worse than
      // one that previews as its first line.
      heightPt: 4,
      fontSizePt: 14,
      borderWidthPt: 0,
      cornerRadiusPt: 0,
      hasBorder: false,
      font,
    });

    expect(layout.fontSizePt).toBe(MIN_STAMP_FONT_SIZE_PT);
    expect(layout.lines).toEqual(["Exhibit A"]);
  });

  // Border and corner geometry is resolved before the label is ever measured,
  // so these cases don't need a loaded font.

  it("clamps the border to a quarter of the stamp's short side", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 115.2,
      heightPt: 72,
      fontSizePt: 14,
      borderWidthPt: 40,
      cornerRadiusPt: 0,
      hasBorder: true,
      font: null,
    });

    expect(layout.borderWidthPt).toBe(18); // 72 * 0.25
  });

  it("resolves the border to zero when the stamp has none, freeing that space for the corner clamp", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 115.2,
      heightPt: 72,
      fontSizePt: 14,
      // A leftover thickness from whenever the stamp last had a border.
      borderWidthPt: 6,
      cornerRadiusPt: 999,
      hasBorder: false,
      font: null,
    });

    expect(layout.borderWidthPt).toBe(0);
    expect(layout.cornerRadiusPt).toBe(36); // 72 / 2, with no border eating in
  });

  it("clamps the corner radius to half the short side inside the border", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 115.2,
      heightPt: 72,
      fontSizePt: 14,
      borderWidthPt: 4,
      cornerRadiusPt: 999,
      hasBorder: true,
      font: null,
    });

    expect(layout.borderWidthPt).toBe(4);
    expect(layout.cornerRadiusPt).toBe(34); // (72 - 4) / 2
  });

  it("floors a negative border thickness and corner radius at zero", () => {
    const layout = computeStampPreviewLayout({
      lines: ["Exhibit A"],
      widthPt: 115.2,
      heightPt: 72,
      fontSizePt: 14,
      borderWidthPt: -5,
      cornerRadiusPt: -3,
      hasBorder: true,
      font: null,
    });

    expect(layout.borderWidthPt).toBe(0);
    expect(layout.cornerRadiusPt).toBe(0);
  });
});
