import { describe, expect, it } from "vitest";
import type { TextLayerCoverage } from "@raiopdf/rules";
import { planOcrRun } from "./ocrRunPlan";

describe("planOcrRun", () => {
  it("keeps normal OCR in skip-text mode when no trivial text image pages are present", () => {
    expect(planOcrRun("skip-text", coverage({
      imageOnlyPages: [1, 2],
      trivialTextImagePages: [],
    }))).toEqual({
      ocrType: "skip-text",
      autoForcePageIndexes: [],
    });
  });

  it("force-OCRs trivial text image pages and image-only pages together in normal mode", () => {
    expect(planOcrRun("skip-text", coverage({
      imageOnlyPages: [1, 3],
      trivialTextImagePages: [
        { pageIndex: 0, textCharacterCount: 8, imageCoverageRatio: 0.99 },
        { pageIndex: 3, textCharacterCount: 12, imageCoverageRatio: 0.9 },
      ],
    }))).toEqual({
      ocrType: "force-ocr",
      pageIndexes: [0, 1, 3],
      autoForcePageIndexes: [0, 3],
    });
  });

  it("leaves manual force OCR as an all-page force pass", () => {
    expect(planOcrRun("force-ocr", coverage({
      imageOnlyPages: [1],
      trivialTextImagePages: [
        { pageIndex: 0, textCharacterCount: 8, imageCoverageRatio: 0.99 },
      ],
    }))).toEqual({
      ocrType: "force-ocr",
      autoForcePageIndexes: [],
    });
  });

  it("does not auto-force when suspect page indexes are malformed", () => {
    expect(planOcrRun("skip-text", coverage({
      trivialTextImagePages: [
        { pageIndex: -1, textCharacterCount: 8, imageCoverageRatio: 0.99 },
        { pageIndex: Number.NaN, textCharacterCount: 8, imageCoverageRatio: 0.99 },
      ],
    }))).toEqual({
      ocrType: "skip-text",
      autoForcePageIndexes: [],
    });
  });
});

function coverage(overrides: Partial<TextLayerCoverage> = {}): TextLayerCoverage {
  return {
    imageOnlyPages: [],
    mixedPages: [],
    textPages: [],
    garbledPages: [],
    trivialTextImagePages: [],
    ...overrides,
  };
}
