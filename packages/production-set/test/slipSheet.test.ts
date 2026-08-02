import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  createSlipSheetPageBytes,
  layoutSlipSheetText,
  SLIP_SHEET_BASIS_MAX_CHARS,
  SLIP_SHEET_MIN_BODY_FONT_SIZE_PT,
  SLIP_SHEET_PAGE_GEOMETRY,
  truncateSlipSheetBasis,
} from "../src/slipSheet";

async function helveticaFont() {
  const pdf = await PDFDocument.create();
  return pdf.embedFont(StandardFonts.Helvetica);
}

describe("truncateSlipSheetBasis", () => {
  it("leaves short text untouched", () => {
    expect(truncateSlipSheetBasis("short description")).toEqual({
      text: "short description",
      truncated: false,
    });
  });

  it(`caps at ${SLIP_SHEET_BASIS_MAX_CHARS} characters, appending an ellipsis`, () => {
    const long = "x".repeat(SLIP_SHEET_BASIS_MAX_CHARS + 250);
    const { text, truncated } = truncateSlipSheetBasis(long);
    expect(truncated).toBe(true);
    expect(text).toBe(`${"x".repeat(SLIP_SHEET_BASIS_MAX_CHARS)}...`);
  });

  it("does not truncate text at exactly the cap", () => {
    const exact = "y".repeat(SLIP_SHEET_BASIS_MAX_CHARS);
    expect(truncateSlipSheetBasis(exact)).toEqual({ text: exact, truncated: false });
  });
});

describe("layoutSlipSheetText", () => {
  it("wraps a long privilege/basis pair and never renders below the 8pt floor", async () => {
    const font = await helveticaFont();
    const longBasis =
      "This is a lengthy free-text description of the withholding, repeated many times over so that it " +
      "must wrap across a large number of lines within a narrow content box. ".repeat(6);

    const layout = layoutSlipSheetText(
      "Attorney-client privilege",
      longBasis,
      font,
      432, // boxWidthPt -- matches the page generator's default margins.
      40, // A deliberately SHORT content height, to force the floor.
    );

    expect(layout.fontSizePt).toBeGreaterThanOrEqual(SLIP_SHEET_MIN_BODY_FONT_SIZE_PT);
    expect(layout.fontSizePt).toBe(SLIP_SHEET_MIN_BODY_FONT_SIZE_PT);
    expect(layout.privilegeLines.length).toBeGreaterThan(0);
    expect(layout.basisLines.length).toBeGreaterThan(1);
    // `longBasis` (~1000 chars, repeated text) is well over the render cap.
    expect(layout.basisTruncated).toBe(true);
  });

  it("picks a larger font size when the content comfortably fits", async () => {
    const font = await helveticaFont();
    const layout = layoutSlipSheetText(
      "Attorney-client privilege",
      "Short basis.",
      font,
      432,
      600, // Generous height -- should not need to shrink.
    );

    expect(layout.fontSizePt).toBeGreaterThan(SLIP_SHEET_MIN_BODY_FONT_SIZE_PT);
  });

  it("caps and marks a basis over the character limit as truncated", async () => {
    const font = await helveticaFont();
    const longBasis = "z".repeat(SLIP_SHEET_BASIS_MAX_CHARS + 100);

    const layout = layoutSlipSheetText("Work product", longBasis, font, 432, 600);

    expect(layout.basisTruncated).toBe(true);
    const rendered = layout.basisLines.join(" ");
    expect(rendered.replace(/\s+/g, "")).toContain("...");
  });

  it("sanitizes unencodable (e.g. CJK/emoji) characters instead of throwing", async () => {
    const font = await helveticaFont();

    expect(() =>
      layoutSlipSheetText(
        "Attorney-client privilege 特権 🔒",
        "説明 basis with emoji 🎉 and CJK 内容 mixed in",
        font,
        432,
        600,
      )
    ).not.toThrow();

    const layout = layoutSlipSheetText(
      "Attorney-client privilege 特権",
      "説明 basis",
      font,
      432,
      600,
    );
    // Every rendered line must be encodable by the SAME font -- if
    // sanitization missed a character, this would throw.
    for (const line of [...layout.privilegeLines, ...layout.basisLines]) {
      expect(() => font.widthOfTextAtSize(line, layout.fontSizePt)).not.toThrow();
    }
  });

  it("handles empty privilege and basis text without producing lines", async () => {
    const font = await helveticaFont();
    const layout = layoutSlipSheetText("", "", font, 432, 600);
    expect(layout.privilegeLines).toEqual([]);
    expect(layout.basisLines).toEqual([]);
  });
});

describe("createSlipSheetPageBytes", () => {
  it("produces a single Letter-size page matching SLIP_SHEET_PAGE_GEOMETRY", async () => {
    const bytes = await createSlipSheetPageBytes({
      privilegeAsserted: "Attorney-client privilege",
      basis: "Internal legal memo",
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBe(SLIP_SHEET_PAGE_GEOMETRY.widthPt);
    expect(page.getHeight()).toBe(SLIP_SHEET_PAGE_GEOMETRY.heightPt);
  });

  it("never throws for unencodable or very long input", async () => {
    await expect(createSlipSheetPageBytes({
      privilegeAsserted: "特権 🔒 Attorney-client privilege",
      basis: "x".repeat(2000) + " 説明 🎉",
    })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("never throws with empty basis", async () => {
    await expect(createSlipSheetPageBytes({
      privilegeAsserted: "Attorney-client privilege",
      basis: "",
    })).resolves.toBeInstanceOf(Uint8Array);
  });
});
